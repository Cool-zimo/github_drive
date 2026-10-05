/**
 * 文件管理器 v2
 * 核心抽象：用户只看到 /drive_home 下的统一文件系统
 * 实际文件可能拆分后散落在多个 GitHub 仓库中
 */
class FileManager {
    constructor(api, storage) {
        this.api = api;
        this.storage = storage;
        this.currentPath = '/drive_home';
    }

    // ==================== 目录导航 ====================
    setCurrentPath(path) {
        this.currentPath = Storage.normalizePath(path);
    }

    // 兼容旧调用的别名方法
    getBreadcrumb(path) { return this.getBreadcrumbs(path); }
    setCurrentRepo(repo) { /* 统一目录视图不需要当前仓库概念 */ }
    get currentRepo() { return null; }

    getCurrentPath() { return this.currentPath; }

    async listFiles(path = this.currentPath) {
        path = Storage.normalizePath(path);
        return this.storage.listDirectory(path);
    }

    getBreadcrumbs(path = this.currentPath) {
        path = Storage.normalizePath(path);
        const parts = path.substring('/drive_home'.length).split('/').filter(Boolean);
        // ★ 根显示"网盘" —— 与桌面版 textutil.py 的 ROOT_LABEL 一致。
        //   drive_home 是内部实现，不该暴露给用户。
        const crumbs = [{ name: BREADCRUMB_ROOT_LABEL, path: '/drive_home' }];
        let current = '/drive_home';
        parts.forEach(part => {
            current += '/' + part;
            // ★ 长名截断：不截断的话深层长目录名会把面包屑撑爆
            crumbs.push({ name: shortenName(part), path: current });
        });

        // ★ 折叠：超过 BREADCRUMB_MAX 时保留根 + 末尾若干级，中间折叠
        //   不折叠的话，深路径只能靠横向滚动才能看到当前位置
        //   （CSS 是 max-width:45% + overflow-x:auto，当前项经常被滚出视野）
        if (crumbs.length > BREADCRUMB_MAX) {
            const tail = Math.max(1, BREADCRUMB_MAX - 2);
            return [crumbs[0],
                    { name: BREADCRUMB_ELLIPSIS, path: null }]
                   .concat(crumbs.slice(crumbs.length - tail));
        }
        return crumbs;
    }

    // ==================== 智能仓库分配 ====================
    /**
     * 预留容量表。
     *
     * ★ 核心 bug：规划阶段连续调用 autoSelectRepo 选仓库，但真正登记用量
     *   （addToRepoUsage）要等到分片上传完之后。中间这段时间里每个分片
     *   看到的都是同一份"还没扣"的剩余容量 ——
     *
     *   实测：仓库只剩 100MB，连选 5 次 32MB（共 160MB），
     *   五次全选中同一个仓库，超额 60MB 却不报错。
     *
     *   后果就是"存储满了"：VFS 以为还有空间，实际仓库被撑爆。
     *
     * 现在规划时先记账（reserved），上传完成转正式、失败则退回。
     */
    _reservedGet(key) { return (this._reserved && this._reserved[key]) || 0; }
    _reservedAdd(key, size) {
        this._reserved = this._reserved || {};
        this._reserved[key] = (this._reserved[key] || 0) + size;
    }
    _reservedSub(key, size) {
        if (!this._reserved) return;
        this._reserved[key] = Math.max(0, (this._reserved[key] || 0) - size);
    }
    _remainingOf(repo, neededSize) {
        const key = `${repo.owner}/${repo.repo}`;
        const base = this.storage.getRepoRemaining(repo.owner, repo.repo);
        const reserved = this._reservedGet(key);
        // 建仓时会预留，所以减掉已经规划出去的部分
        return Math.max(0, base - reserved);
    }

    async autoSelectRepo(neededSize) {
        const config = this.storage.getStorageConfig();
        const currentUser = this.storage.getUser()?.login;
        let repos = this.storage.getRepos();

        // ★ 分块超过单仓上限时直接报错，不能走进下面的 autoCreateRepo
        //
        //   否则 canRepoFit 永远 false → 每个分片都 create_repo。
        //   500MB 文件 × 512KB 分片 = 上千次 create_repo，
        //   而且新建的仓库同样装不下 —— 问题没解决只是被放大。
        //
        //   ★ 这个保护此前只在桌面版 Python 侧做过（v0.0.9），
        //     js 侧（线上实际在跑的这份）从来没修 —— 双实现的代价。
        if (neededSize > config.maxRepoSize) {
            throw new Error(
                `单个分块 ${Storage.formatBytes(neededSize)} 超过仓库上限 ` +
                `${Storage.formatBytes(config.maxRepoSize)}，无法上传`);
        }
        
        // 关键修复：只选择 owner 和当前用户匹配的仓库，避免访问其他账号的仓库导致 401
        if (currentUser) {
            const validRepos = repos.filter(r => r.owner === currentUser);
            if (validRepos.length !== repos.length) {
                console.warn(`[FileManager] 过滤掉 ${repos.length - validRepos.length} 个 owner 不匹配的仓库`);
                repos = validRepos;
                this.storage.setRepos(validRepos);
            }
        }

        const defaultRepo = this.storage.getDefaultRepo();
        if (defaultRepo && defaultRepo.owner === currentUser && this._remainingOf(defaultRepo) >= neededSize) {
            this._reservedAdd(`${defaultRepo.owner}/${defaultRepo.repo}`, neededSize);
            return defaultRepo;
        }

        const otherRepos = repos
            .filter(r => !r.isDefault)
            .sort((a, b) => this._remainingOf(b) - this._remainingOf(a));
        for (const repo of otherRepos) {
            if (this._remainingOf(repo) >= neededSize) {
                this._reservedAdd(`${repo.owner}/${repo.repo}`, neededSize);
                return repo;
            }
        }

        if (config.autoCreateRepo) {
            return await this.autoCreateStorageRepo();
        }

        throw new Error('所有仓库容量不足，且未开启自动创建仓库功能');
    }

    async autoCreateStorageRepo() {
        const config = this.storage.getStorageConfig();
        const date = new Date().toISOString().split('T')[0];
        const random = Math.random().toString(16).substring(2, 6);
        const repoName = `${config.repoNamePrefix}-${date}-${random}`;

        console.log(`[FileManager] 自动创建存储仓库: ${repoName}`);
        // ★ 第二个参数是 options 对象，不是布尔。
        //   之前传 `true`：`true.description` 是 undefined，描述丢了；
        //   private/autoInit 只是碰巧对（undefined !== false），纯属运气。
        const repo = await this.api.createRepository(repoName, {
            description: 'GitHub Drive 自动创建的存储仓库',
            private: true,
            autoInit: true
        });
        const repoInfo = {
            owner: repo.owner.login,
            repo: repo.name,
            name: repo.name,
            branch: 'main',
            isDefault: this.storage.getRepos().length === 0
        };
        this.storage.addRepo(repoInfo);
        this._reservedAdd(`${repoInfo.owner}/${repoInfo.repo}`, 0);   // 确保 key 存在
        return repoInfo;
    }

    // ==================== 文件上传（支持自动拆分） ====================

    /**
     * 分片规划。
     *
     * 实测结论（详见 COOL-DOC → GitHub Drive → 传输性能与分片算法）：
     *   1. 每片约 1~2 秒固定开销（TLS 握手 + API 往返），按片数付
     *   2. 并发 4 相比串行快 4 倍；再往上收益很小，瓶颈在 GitHub 侧
     *   3. 一次 commit 固定约 5.7 秒，与提交多少个文件无关 → 批次数越少越好
     *   4. 单个 blob 上限 ~38MB（卡的是 base64 之后的 payload，膨胀 33%）
     *
     * 所以最优解不是"固定一个分片大小"，而是：
     *   片数 ≈ 并发数，单片尽量大，最后所有片挤进一次 tree + commit。
     *
     * @returns {{direct:boolean, chunkSize:number, totalChunks:number, concurrency:number}}
     */
    /**
     * 分片 + 并发规划。
     *
     * 实测依据（详见 COOL-DOC → GitHub Drive → 传输性能与分片算法）：
     *   1. 每片约 1~2 秒固定开销（TLS 握手 + API 往返），按片数付
     *   2. 单片越大越接近带宽上限（实测封顶 ~7.9MB/s），所以大文件要少分片
     *   3. 单片上限 ~38MB（卡的是 base64 之后的 payload）
     *   4. 并发不是越大越好：32 片实测 conc16 = 14.63s 最优，conc24 = 20.52s 反而变慢
     *   5. 片数多时并发收益明显（32 片：conc4 18.46s → conc16 14.63s）
     *
     * 三个参数互相牵制，所以分三步定：
     *   分片大小 → 片数 → 并发数（受内存与实测上限双重约束）
     *
     * @returns {{direct:boolean, chunkSize:number, totalChunks:number, concurrency:number}}
     */
    planUpload(totalSize, config) {
        const DIRECT_MAX  = config.directMaxSize || 1 * 1024 * 1024;
        const MIN_CHUNK   = config.minChunkSize  || 1 * 1024 * 1024;
        const MAX_CHUNK   = config.chunkSize     || 32 * 1024 * 1024;
        // 并发硬上限：实测 conc24 已劣化，conc16 是拐点
        const HARD_CONC   = Math.max(1, Math.min(16, config.maxConcurrency || 16));
        // 内存预算：base64 膨胀 1.34 倍，一次只允许这么多字节在内存里
        const MEM_BUDGET  = config.memoryBudget || 512 * 1024 * 1024;

        // 小文件直传：切分只会多付固定开销，没有任何收益
        if (totalSize <= DIRECT_MAX) {
            return { direct: true, chunkSize: totalSize, totalChunks: 1, concurrency: 1 };
        }

        // ── 第一步：分片大小 ──
        // 目标片数 4（够吃满并发即可，再多纯付固定开销），再套上下限。
        // 32MB 上限是 blob 的硬约束；1MB 下限是因为更小的片固定开销占比过高。
        let chunkSize = Math.ceil(totalSize / 4);
        chunkSize = Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, chunkSize));
        const totalChunks = Math.ceil(totalSize / chunkSize);

        // ── 第二步：并发数 ──
        // 上限一：内存。单片越大，能同时编码的数量越少。
        //         512MB/(32MB×1.34) ≈ 11 —— 一次性编码 16 个 32MB 分片要 672MB，
        //         实测会直接被系统杀掉（512MB 那次就是这么没的）。
        const maxByMemory = Math.max(1, Math.floor(MEM_BUDGET / (chunkSize * 1.34)));

        // 上限二：实测拐点 16，再加只会劣化
        const concurrency = Math.max(1, Math.min(totalChunks, maxByMemory, HARD_CONC));

        return { direct: false, chunkSize, totalChunks, concurrency };
    }

    async uploadFile(file, targetPath = this.currentPath, onProgress = null) {
        const config = this.storage.getStorageConfig();
        const virtualPath = Storage.normalizePath(targetPath) + '/' + file.name;
        const totalSize = file.size;

        // ★ 覆盖上传会泄漏旧分片（线上实测：56.2MB / 45 个文件因此丢失）
        //   成因：每次上传都新建随机目录 `mtrand/filename`，VFS 只指向最新那份，
        //   旧目录的 blob 从不删除。所以先记住旧记录，新版本写成功后再清理。
        //   ★ 顺序不能反：先删旧的、新上传又失败 = 文件彻底没了。
        const oldFile = this.storage.getFile(virtualPath);
        const oldChunks = (oldFile && Array.isArray(oldFile.chunks))
            ? oldFile.chunks.slice() : [];

        const plan = this.planUpload(totalSize, config);
        console.log(`[FileManager] 上传 ${file.name} (${Storage.formatBytes(totalSize)})` +
            (plan.direct ? ' → 直传' : ` → ${plan.totalChunks} 片 × ${Storage.formatBytes(plan.chunkSize)}`));

        const chunks = [];

        try {
            if (plan.direct) {
                // ── 小文件：一次 contents API 直传，不建 blob 不建 tree ──
                const repo = await this.autoSelectRepo(totalSize);
                const chunkPath = `${Date.now().toString(36)}/${file.name}`;
                const arrayBuffer = await file.arrayBuffer();
                const base64 = this.arrayBufferToBase64(arrayBuffer);
                const res = await this.api.createOrUpdateFileBinary(
                    repo.owner, repo.repo, chunkPath, base64,
                    `上传文件: ${file.name}`, repo.branch);

                chunks.push({
                    owner: repo.owner,
                    repo: repo.repo,
                    path: chunkPath,
                    size: totalSize,
                    sha: (res && res.content && res.content.sha) || '',
                    branch: repo.branch
                });
                this.storage.addToRepoUsage(repo.owner, repo.repo, totalSize);
                this._reservedSub(`${repo.owner}/${repo.repo}`, totalSize);   // 规划预留转正
                if (onProgress) onProgress(100);

            } else {
                // ── 阶段 1：规划 + 选仓库（串行，纯本地计算，很快）──
                const dir = Date.now().toString(36);   // 本次上传共用一个目录
                const tasks = [];
                for (let i = 0; i < plan.totalChunks; i++) {
                    const start = i * plan.chunkSize;
                    const end = Math.min(start + plan.chunkSize, totalSize);
                    const size = end - start;
                    const repo = await this.autoSelectRepo(size);
                    tasks.push({
                        index: i,
                        start, end, size, repo,
                        name: `${file.name}.${i + 1}`,
                        path: `${dir}/${file.name}.${i + 1}`
                    });
                }
                if (onProgress) onProgress(5);

                // ── 阶段 2：并发建 blob ──
                // 只建 blob，不做 tree/commit —— 那两笔留到最后各仓库各做一次。
                // 旧实现是每个分片一次完整提交（getRef + getCommit + createBlob
                // + createTree + createCommit + updateRef + 再查一次 sha = 7 次
                // API 调用），100MB 文件就是 200 × 7 = 1400 次请求。
                //
                // ★ 必须分批：一次性把全部切片读进内存会爆。512MB 按 32MB 分片
                //   是 16 片，每片 base64 后 42MB，全编码就是 672MB 字符串同时在
                //   内存里（实测直接被系统杀掉，且没有任何报错）。
                const uploaded = [];
                for (let s = 0; s < tasks.length; s += plan.concurrency) {
                    const batch = tasks.slice(s, s + plan.concurrency);
                    const results = await Promise.all(batch.map(async (t) => {
                        const arrayBuffer = await file.slice(t.start, t.end).arrayBuffer();
                        const blob = await this.api.createBlobFromArrayBuffer(
                            t.repo.owner, t.repo.repo, arrayBuffer);
                        return { task: t, sha: blob.sha };
                    }));
                    uploaded.push(...results);

                    if (onProgress) {
                        const done = Math.min(tasks.length, s + batch.length);
                        onProgress(Math.round(5 + (done / tasks.length) * 85));
                    }
                }

                // ── 阶段 3：按仓库分组，每组一次 tree + 一次 commit ──
                // 为什么必须分组：不同分片可能被 autoSelectRepo 分到不同仓库。
                // 为什么每组只做一次：commit 那 5.7 秒是付给"一笔提交"的，
                // 跟提交多少个文件无关 —— 拆成多次就是白送 5.7 × N 秒。
                const byRepo = new Map();
                for (const { task, sha } of uploaded) {
                    const key = `${task.repo.owner}/${task.repo.repo}`;
                    if (!byRepo.has(key)) byRepo.set(key, { repo: task.repo, items: [] });
                    byRepo.get(key).items.push({ task, sha });
                }

                let groupIndex = 0;
                for (const { repo, items } of byRepo.values()) {
                    // blob 的 sha 就是 contents API 的文件 sha（已实测验证：
                    // 同一份内容两种方式拿到的 sha 完全相同），所以不用像旧实现
                    // 那样每片再查一次 getFileContents —— 省掉 N 次请求。
                    const ref = await this.api.getRef(repo.owner, repo.repo, `heads/${repo.branch}`);
                    const latestCommitSha = ref.object.sha;
                    const latestCommit = await this.api.getCommit(repo.owner, repo.repo, latestCommitSha);

                    let baseTreeSha = latestCommit.tree.sha;
                    let parentSha = latestCommitSha;

                    // tree 一次最多放这么多条目（保守值，实测 256 也可行，
                    // 但 payload 会明显变大）。超过就分多批 —— 但仍是同一条链，
                    // 每批一次 commit。
                    const TREE_MAX = 128;
                    for (let b = 0; b < items.length; b += TREE_MAX) {
                        const slice = items.slice(b, b + TREE_MAX);
                        const tree = await this.api.createTree(repo.owner, repo.repo,
                            slice.map(({ task, sha }) => ({
                                path: task.path, mode: '100644', type: 'blob', sha
                            })), baseTreeSha);
                        const commit = await this.api.createCommit(repo.owner, repo.repo,
                            `上传分片: ${file.name} (${slice.length})`, tree.sha, [parentSha]);
                        await this.api.updateRef(repo.owner, repo.repo,
                            `heads/${repo.branch}`, commit.sha);
                        baseTreeSha = tree.sha;
                        parentSha = commit.sha;
                    }

                    for (const { task, sha } of items) {
                        chunks.push({
                            owner: repo.owner,
                            repo: repo.repo,
                            path: task.path,
                            size: task.size,
                            sha: sha,
                            branch: repo.branch
                        });
                        this.storage.addToRepoUsage(repo.owner, repo.repo, task.size);
                        this._reservedSub(`${repo.owner}/${repo.repo}`, task.size);   // 规划预留转正
                    }
                    groupIndex++;
                    if (onProgress) {
                        onProgress(Math.round(90 + (groupIndex / byRepo.size) * 10));
                    }
                }
            }
        } catch (uploadError) {
            console.warn(`[FileManager] 上传失败，正在清理 ${chunks.length} 个已写入分片...`);

            // 401/404：可能是仓库列表里有无效仓库（其他账号的或已删除的）
            if (uploadError.status === 401 || uploadError.status === 404) {
                const currentUser = this.storage.getUser()?.login;
                if (currentUser) {
                    const repos = this.storage.getRepos();
                    const validRepos = repos.filter(r => r.owner === currentUser);
                    if (validRepos.length !== repos.length) {
                        console.warn(`[FileManager] 自动清理 ${repos.length - validRepos.length} 个无效仓库记录`);
                        this.storage.setRepos(validRepos);
                    }
                }
                uploadError.message = uploadError.status === 401
                    ? 'Token 无效或仓库无权限，已自动清理无效仓库记录，请重试'
                    : '仓库不存在或无权限，已自动清理无效仓库记录，请重试';
            }
            // ★ 失败也要退回预留：否则这份"幽灵占用"会一直挂着，
            //   后续上传会误以为仓库满了，白白多建仓库
            for (const t of (typeof tasks !== 'undefined' ? tasks : [])) {
                this._reservedSub(`${t.repo.owner}/${t.repo.repo}`, t.size);
            }
            for (const chunk of chunks) {
                try {
                    if (chunk.sha) {
                        await this.api.deleteFile(chunk.owner, chunk.repo, chunk.path,
                            `清理上传失败的分片: ${chunk.path}`, chunk.branch, chunk.sha);
                        this.storage.subtractFromRepoUsage?.(chunk.owner, chunk.repo, chunk.size);
                    }
                } catch (cleanupError) {
                    console.warn(`[FileManager] 清理分片失败: ${chunk.path}`, cleanupError.message);
                }
            }
            // 注意：只建了 blob、还没进 tree 的那些分片是"游离"的，
            // contents API 删不掉（它们不在任何 tree 里）。GitHub 会自行回收，
            // 且不计入仓库配额，所以这里不逐个尝试删除。
            console.log(`[FileManager] 已清理 ${chunks.length} 个分片`);
            throw uploadError;
        }

        const fileInfo = this.storage.putFile(virtualPath, {
            name: file.name,
            size: totalSize,
            chunks: chunks
        });

        // ★ 新版本已写入 VFS，此时旧分片才真正成为孤儿，可以安全清理
        if (oldChunks.length) {
            await this._cleanupOrphanChunks(oldChunks, virtualPath);
        }

        console.log(`[FileManager] 上传完成: ${virtualPath}, 共 ${chunks.length} 个分片`);
        return { virtualPath, fileInfo, chunks, split: chunks.length > 1 };
    }

    async uploadFiles(files, targetPath = this.currentPath, onProgress = null) {
        const results = [];
        for (let i = 0; i < files.length; i++) {
            const result = await this.uploadFile(files[i], targetPath, (percent) => {
                if (onProgress) onProgress(i, percent, files.length);
            });
            results.push(result);
        }
        return { count: files.length, results };
    }

    // ==================== 文件下载（自动合并分片） ====================
    async downloadFile(virtualPath, onProgress = null) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');

        console.log(`[FileManager] 下载文件: ${virtualPath}, 分片数: ${fileInfo.chunks.length}`);

        const parts = [];
        const totalChunks = fileInfo.chunks.length;
        for (let i = 0; i < totalChunks; i++) {
            const chunk = fileInfo.chunks[i];
            console.log(`[FileManager] 下载分片 ${i + 1}/${totalChunks}: ${chunk.repo}/${chunk.path}`);
            const content = await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch);
            if (content instanceof Uint8Array) {
                parts.push(content);
            } else if (content instanceof ArrayBuffer) {
                parts.push(new Uint8Array(content));
            } else {
                throw new Error('分片数据类型错误');
            }
            if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 100), i + 1, totalChunks);
        }
        const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) { merged.set(p, offset); offset += p.length; }
        const mergedBlob = new Blob([merged], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(mergedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileInfo.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 1000);

        this.storage.addToRecent(virtualPath);
        console.log(`[FileManager] 下载完成: ${fileInfo.name}`);
    }


    // 写入文本文件内容（用于在线编辑器）
    async writeFileContent(virtualPath, content) {
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');
        
        const chunks = this.storage.getFileChunks(virtualPath);
        if (!chunks || chunks.length === 0) throw new Error('文件分片信息不存在');
        
        // 使用第一个分片的仓库信息
        const chunk = chunks[0];
        const fileName = virtualPath.split('/').pop();
        
        // 对于小文件，直接覆盖写入
        if (content.length < 1024 * 1024) { // 小于1MB
            const base64 = btoa(unescape(encodeURIComponent(content)));
            await this.api.createOrUpdateFile(
                chunk.owner, chunk.repo, chunk.path,
                base64,
                `编辑文件: ${fileName}`,
                chunk.branch || 'main',
                chunk.sha || null
            );
            
            // 更新本地文件信息
            this.storage.updateFile(virtualPath, {
                size: new Blob([content]).size,
                modified: new Date().toISOString()
            });
            
            return true;
        }
        
        throw new Error('文件过大，请使用上传功能');
    }

    async getFileContent(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');

        const parts = [];
        for (const chunk of fileInfo.chunks) {
            const content = await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch);
            parts.push(content);
        }
        // 合并所有分片的字节，再按 UTF-8 解码为文本
        const totalLen = parts.reduce((sum, p) => sum + (p.length || 0), 0);
        if (totalLen === 0) return '';
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) {
            merged.set(p, offset);
            offset += p.length;
        }
        return new TextDecoder('utf-8').decode(merged);
    }

    /**
     * 获取文件二进制内容（Blob），用于预览和下载
     */
    async getFileBlob(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');
        if (!fileInfo.chunks || fileInfo.chunks.length === 0) throw new Error('文件分片信息缺失');

        const parts = [];
        for (let i = 0; i < fileInfo.chunks.length; i++) {
            const chunk = fileInfo.chunks[i];
            try {
                const content = await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch);
                // 确保是 Uint8Array
                if (content instanceof Uint8Array) {
                    parts.push(content);
                } else if (content instanceof ArrayBuffer) {
                    parts.push(new Uint8Array(content));
                } else if (typeof content === 'string') {
                    // base64 字符串，转换
                    const binary = atob(content);
                    const bytes = new Uint8Array(binary.length);
                    for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
                    parts.push(bytes);
                } else {
                    console.warn('[FileManager] 分片 ' + i + ' 返回未知类型:', typeof content);
                    throw new Error('分片数据类型错误');
                }
            } catch (e) {
                console.error('[FileManager] 下载分片 ' + i + ' 失败:', e);
                throw new Error('下载分片失败: ' + e.message);
            }
        }
        const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
        if (totalLen === 0) throw new Error('文件内容为空');
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const p of parts) {
            merged.set(p, offset);
            offset += p.length;
        }
        return new Blob([merged], { type: this.guessMimeType(fileInfo.name) });
    }

    /**
     * 根据文件名猜测 MIME 类型
     */
    guessMimeType(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = {
            pdf: 'application/pdf',
            txt: 'text/plain', md: 'text/markdown', html: 'text/html', htm: 'text/html',
            css: 'text/css', js: 'application/javascript', json: 'application/json',
            xml: 'application/xml', csv: 'text/csv',
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
            svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
            mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
            mp4: 'video/mp4', webm: 'video/webm',
            zip: 'application/zip', rar: 'application/vnd.rar',
            '7z': 'application/x-7z-compressed', tar: 'application/x-tar', gz: 'application/gzip',
            doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        };
        return map[ext] || 'application/octet-stream';
    }

    /**
     * ArrayBuffer 转 base64（用于二进制文件上传）
     */
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 8192;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    /**
     * 清理孤儿分片（覆盖上传/删除时遗留）
     *
     * ★ 这里**不能抛异常**。调用方（uploadFile）已经成功了，
     *   因为清理旧分片失败就报"上传失败"是错的 —— 文件明明在。
     *   失败的分片记进 pendingOrphanChunks，下次有机会再清。
     */
    async _cleanupOrphanChunks(chunks, why) {
        for (const chunk of chunks) {
            try {
                let sha = chunk.sha;
                try {
                    const fi = await this.api.getFileContents(
                        chunk.owner, chunk.repo, chunk.path, chunk.branch);
                    sha = fi.sha || sha;
                } catch (e) { /* 用记录里的 sha */ }

                if (!sha) {
                    this._pendingOrphan(chunk, why, '无 sha，跳过');
                    continue;
                }
                await this.api.deleteFile(chunk.owner, chunk.repo, chunk.path,
                    `清理孤儿分片: ${chunk.path}`, chunk.branch, sha);
                this.storage.subtractFromRepoUsage?.(
                    chunk.owner, chunk.repo, chunk.size);
            } catch (e) {
                // ★ 不 throw：清理失败不影响主流程，但要留痕
                this._pendingOrphan(chunk, why, e.message);
            }
        }
    }

    _pendingOrphan(chunk, why, err) {
        if (!this.pendingOrphanChunks) this.pendingOrphanChunks = [];
        this.pendingOrphanChunks.push({
            owner: chunk.owner, repo: chunk.repo, path: chunk.path,
            size: chunk.size, why: why, error: err,
            at: new Date().toISOString()
        });
        console.warn(`[FileManager] 孤儿分片清理失败（已记入待清理）: ${chunk.path}`, err);
    }

    // ==================== 文件删除 ====================
    async deleteFile(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        const fileInfo = this.storage.getFile(virtualPath);
        if (!fileInfo) throw new Error('文件不存在');

        console.log(`[FileManager] 删除文件: ${virtualPath}, 分片数: ${fileInfo.chunks.length}`);

        for (let i = 0; i < fileInfo.chunks.length; i++) {
            const chunk = fileInfo.chunks[i];
            try {
                let sha = chunk.sha;
                try {
                    const fi = await this.api.getFileContents(chunk.owner, chunk.repo, chunk.path, chunk.branch);
                    sha = fi.sha;
                } catch (e) { /* 忽略 */ }

                await this.api.deleteFile(chunk.owner, chunk.repo, chunk.path, `删除分片: ${chunk.path}`, chunk.branch, sha);
                console.log(`[FileManager] 已删除分片 ${i + 1}/${fileInfo.chunks.length}: ${chunk.repo}/${chunk.path}`);
            } catch (e) {
                // ★ 原来是纯 console.warn —— 分片静默留下，
                //   时间一长就变成"界面看不到但占容量"的孤儿数据。
                //   现在记进 pendingOrphanChunks，可被扫描/重试发现。
                this._pendingOrphan(chunk, virtualPath, e.message);
            }
        }

        this.storage.deleteFile(virtualPath);
        console.log(`[FileManager] 文件已从 VFS 删除: ${virtualPath}`);
    }

    // ==================== 文件夹操作 ====================
    async createFolder(folderName, targetPath = this.currentPath) {
        const virtualPath = Storage.normalizePath(targetPath) + '/' + folderName;
        if (this.storage.exists(virtualPath)) {
            throw new Error('文件夹已存在');
        }
        this.storage.putFolder(virtualPath);
        console.log(`[FileManager] 创建文件夹: ${virtualPath}`);
        return { virtualPath, name: folderName };
    }

    async deleteFolder(virtualPath) {
        virtualPath = Storage.normalizePath(virtualPath);
        if (virtualPath === '/drive_home') throw new Error('不能删除根目录');

        const items = this.storage.listDirectory(virtualPath);
        console.log(`[FileManager] 删除文件夹: ${virtualPath}, 包含 ${items.length} 个项目`);

        for (const item of items) {
            if (item.isFile) {
                await this.deleteFile(item.path);
            } else if (item.isFolder) {
                await this.deleteFolder(item.path);
            }
        }

        this.storage.deleteFolder(virtualPath);
    }


    // 移动文件
    async moveFile(sourcePath, targetPath) {
        // 读取源文件内容
        const content = await this.getFileContent(sourcePath);
        if (content === null) throw new Error('无法读取源文件');
        // 写入目标位置
        await this.writeFileContent(targetPath, content);
        // 删除源文件
        await this.deleteFile(sourcePath);
        return true;
    }

    async renameItem(virtualPath, newName) {
        virtualPath = Storage.normalizePath(virtualPath);
        const parentPath = Storage.getParentPath(virtualPath);
        const newPath = parentPath + '/' + newName;

        if (this.storage.exists(newPath)) throw new Error('目标名称已存在');

        this.storage.moveItem(virtualPath, newPath);
        console.log(`[FileManager] 重命名: ${virtualPath} → ${newPath}`);
        return { oldPath: virtualPath, newPath, name: newName };
    }

    // ==================== 搜索 ====================
    searchFiles(query) {
        return this.storage.searchFiles(query);
    }

    // ==================== 容量同步 ====================
    async syncAllRepoUsage() {
        const repos = this.storage.getRepos();
        const invalidRepos = [];
        for (const repo of repos) {
            try {
                const repoInfo = await this.api.getRepository(repo.owner, repo.repo);
                const sizeKB = repoInfo.size || 0;
                this.storage.setRepoUsage(repo.owner, repo.repo, sizeKB * 1024);
            } catch (e) {
                // 404 说明仓库不存在，自动移除
                if (e.status === 404) {
                    console.warn(`[FileManager] 仓库不存在，自动移除: ${repo.owner}/${repo.repo}`);
                    invalidRepos.push(repo);
                } else {
                    console.warn(`[FileManager] 同步仓库容量失败: ${repo.name}`, e.message);
                }
            }
        }
        // 移除无效仓库
        for (const repo of invalidRepos) {
            this.storage.removeRepo(repo.owner, repo.repo);
        }
        if (invalidRepos.length > 0) {
            console.log(`[FileManager] 已自动移除 ${invalidRepos.length} 个无效仓库`);
        }
        console.log('[FileManager] 所有仓库容量同步完成');
    }

    // ==================== 工具方法 ====================
    static formatSize(bytes) { return Storage.formatBytes(bytes); }

    static getFileIcon(name, type) {
        if (type === 'dir') return '📁';
        const ext = name.split('.').pop().toLowerCase();
        const icons = {
            jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', bmp: '🖼️', ico: '🖼️',
            mp4: '🎬', avi: '🎬', mov: '🎬', wmv: '🎬', flv: '🎬', mkv: '🎬', webm: '🎬',
            mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', wma: '🎵', m4a: '🎵',
            pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
            txt: '📄', md: '📝', json: '📋', xml: '📋', yaml: '📋', yml: '📋',
            js: '📜', ts: '📜', py: '📜', java: '📜', c: '📜', cpp: '📜', go: '📜', rs: '📜',
            html: '🌐', css: '🎨', zip: '🗜️', rar: '🗜️', '7z': '🗜️', tar: '🗜️', gz: '🗜️',
            exe: '⚙️', dmg: '💿', iso: '💿', apk: '📱', ipa: '📱'
        };
        return icons[ext] || '📄';
    }
}
