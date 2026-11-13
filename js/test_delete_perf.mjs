/**
 * 删除路径：不再为每个分片白跑一次 contents GET
 *
 * ★ 背景
 *   VFS 里记的 chunk.sha 就是上传时 createBlob 返回的 blob sha。
 *   旧实现删每个分片前都先 getFileContents 取一次「最新 sha」，
 *   而 contents API 对 >1MB 的分片返回 encoding:none + 空 content
 *   （见 github-api.js getFileRaw 里的同类注释）——请求发出去了，
 *   内容没拿到，等于删一个 100MB 文件前又把它白下载一遍。
 *
 * 重点不是「能删掉」，而是：
 *   1. sha 有效时一个分片只发 1 个请求（DELETE），不发 GET
 *   2. sha 过期（409）能自动取新 sha 重试，正确性不降
 *   3. sha 缺失仍会去取（旧行为保留）
 *   4. 非 409 错误不重试、不吞，仍记进 pendingOrphanChunks
 *   5. deleteFile 与 _cleanupOrphanChunks 两条路径行为一致
 */
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(new URL('./file-manager.js', import.meta.url), 'utf8');

class StorageStub {
    constructor(vfs) {
        this.vfs = vfs; this.repos = []; this.user = { login: 'me' };
        this.subtracted = [];
    }
    getVFS() { return this.vfs; }
    setVFS(v) { this.vfs = v; }
    getUser() { return this.user; }
    setUser(u) { this.user = u; }
    getRepos() { return this.repos; }
    setRepos(r) { this.repos = r; }
    getStorageConfig() { return { maxRepoSize: 900 * 1024 * 1024 }; }
    getFile(p) { return this.vfs.files[p]; }
    deleteFile(p) { delete this.vfs.files[p]; }
    subtractFromRepoUsage(o, r, n) { this.subtracted.push([o, r, n]); }
    addToRepoUsage() {}
    static normalizePath(p) { return p.startsWith('/drive_home') ? p : '/drive_home/' + p.replace(/^\//, ''); }
}

function loadClass() {
    const ctx = vm.createContext({ Storage: StorageStub, console, setTimeout, clearTimeout });
    vm.runInContext(src, ctx);
    return vm.runInContext('FileManager', ctx);
}

const FileManager = loadClass();
const PATH = '/drive_home/big.bin';

function chunk(i, withSha = true) {
    const c = { owner: 'me', repo: 'drive-storage-1', path: 'chunks/' + i + '.bin',
                branch: 'main', size: 1024 };
    if (withSha) c.sha = 'sha-' + i;
    return c;
}

function makeApi(opts = {}) {
    const calls = [];
    return {
        calls,
        async getMe() { return { login: 'me' }; },
        async getFileContents() {
            calls.push(['getFileContents']);
            if (opts.getFails) throw Object.assign(new Error('404'), { status: 404 });
            return { sha: opts.freshSha || 'fresh-sha' };
        },
        async deleteFile(o, r, p, msg, branch, sha) {
            calls.push(['deleteFile', p, sha]);
            if (opts.conflictOnce && !this._done409) {
                this._done409 = true;
                throw Object.assign(new Error('sha 不匹配'), { status: 409 });
            }
            if (opts.deleteFails) {
                throw Object.assign(new Error('403'), { status: opts.deleteFails });
            }
            return {};
        },
    };
}

function makeFM(api, chunks) {
    const vfs = { files: { [PATH]: { name: 'big.bin', size: 3072, chunks } } };
    const storage = new StorageStub(vfs);
    const fm = new FileManager(api, storage);
    // 身份校验走真实 _guardChunks，只把取身份这一步固定住
    fm._ensureIdentity = async () => 'me';
    return { fm, storage, vfs };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const n = (api, kind) => api.calls.filter(c => c[0] === kind).length;

// 1. 正常：3 个分片都有 sha —— 应当 0 次 GET、3 次 DELETE
{
    const api = makeApi();
    const { fm, vfs } = makeFM(api, [chunk(1), chunk(2), chunk(3)]);
    await fm.deleteFile(PATH);
    check('有 sha 时不发 contents GET', n(api, 'getFileContents') === 0,
          '实际 ' + n(api, 'getFileContents') + ' 次');
    check('每个分片恰好 1 次 DELETE', n(api, 'deleteFile') === 3);
    check('删完从 VFS 移除', !(PATH in vfs.files));
}

// 2. sha 过期：第一次 DELETE 抛 409 —— 取新 sha 后重试成功
{
    const api = makeApi({ conflictOnce: true, freshSha: 'new-sha' });
    const { fm } = makeFM(api, [chunk(1)]);
    await fm.deleteFile(PATH);
    check('409 时补发 1 次 GET', n(api, 'getFileContents') === 1,
          '实际 ' + n(api, 'getFileContents') + ' 次');
    check('409 后重试 DELETE', n(api, 'deleteFile') === 2);
    check('重试用的是新 sha', api.calls.filter(c => c[0] === 'deleteFile').pop()[2] === 'new-sha');
    check('409 不计入孤儿', !(fm.pendingOrphanChunks || []).length);
}

// 3. VFS 没存 sha —— 仍要先取
{
    const api = makeApi({ freshSha: 'fetched-sha' });
    const { fm } = makeFM(api, [chunk(1, false)]);
    await fm.deleteFile(PATH);
    check('无 sha 时补 1 次 GET', n(api, 'getFileContents') === 1);
    check('用取回的 sha 删除', api.calls.filter(c => c[0] === 'deleteFile').pop()[2] === 'fetched-sha');
}

// 4. 非 409 错误：不重试 GET、不吞异常，记进待清理
{
    const api = makeApi({ deleteFails: 403 });
    const { fm, vfs } = makeFM(api, [chunk(1)]);
    await fm.deleteFile(PATH);
    check('403 不触发 GET 重试', n(api, 'getFileContents') === 0);
    check('403 记入 pendingOrphanChunks', (fm.pendingOrphanChunks || []).length === 1);
    check('失败不阻断主流程（VFS 仍移除）', !(PATH in vfs.files));
}

// 5. _cleanupOrphanChunks 同路径、且不抛
{
    const api = makeApi();
    const { fm, storage } = makeFM(api, []);
    await fm._cleanupOrphanChunks([chunk(1), chunk(2)], '覆盖上传');
    check('清理不跑 contents GET', n(api, 'getFileContents') === 0,
          '实际 ' + n(api, 'getFileContents') + ' 次');
    check('清理每个分片 1 次 DELETE', n(api, 'deleteFile') === 2);
    check('清理仍扣减记账', storage.subtracted.length === 2);
}

// 6. 清理时无 sha 且 GET 也失败 —— 只记待清理，绝不抛
{
    const api = makeApi({ getFails: true });
    const { fm } = makeFM(api, []);
    let threw = false;
    try { await fm._cleanupOrphanChunks([chunk(1, false)], '测试'); } catch (e) { threw = true; }
    check('清理失败不抛（调用方已成功）', !threw);
    check('清理失败记入待清理', (fm.pendingOrphanChunks || []).length === 1);
}

console.log('\n删除路径性能回归: ' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
