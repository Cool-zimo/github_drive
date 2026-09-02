/**
 * 应用主入口 v2
 * 统一目录视图，用户感受不到仓库存在
 */
class App {
    constructor() {
        this.api = null;
        this.storage = new Storage();
        this.fileManager = null;
        this.shareManager = null;
        this.configSync = null;
        // 初始设为 null，稍后在 DOM 加载完成后初始化
        this.ui = null;
        this.currentFiles = [];
    }

    async init() {
        I18n.init();
        // 显示版本号
        this.updateAppVersion();
        const token = this.storage.getToken();
        if (token) {
            // 有本地 token：先显示应用界面（避免闪登录页），再异步验证
            this.showApp();
            await this.initializeWithToken(token);
        } else {
            this.showLogin();
        }
    }

    showLogin() {
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('app').classList.add('hidden');
        // 检查后端是否支持 OAuth
        this.ui?.renderSavedAccounts();
    }
    

    showApp() {
        document.getElementById('login-screen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
    }

    // 显示应用版本号（从 script 标签提取）
    updateAppVersion() {
        const versionEl = document.getElementById('app-version');
        if (!versionEl) return;
        // 对外显示正式版本号，内部日期版本号作为 tooltip
        const formalVersion = (typeof APP_VERSION !== 'undefined') ? APP_VERSION.displayVersion : 'v0.0.0';
        const dateVersion = (typeof APP_VERSION !== 'undefined') ? APP_VERSION.internalVersion : 'unknown';
        versionEl.textContent = formalVersion;
        versionEl.title = I18n.t('app.versionTitle').replace('{version}', dateVersion);
    }

    async login(token) {
        token = token.trim();
        if (!token) { 
            this.ui?.showToast(I18n.t('login.enterToken'), 'error'); 
            return; 
        }
        
        // 更严格的 Token 格式校验
        if (!token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
            this.ui?.showToast(I18n.t('login.tokenPrefix'), 'error');
            console.error('[App] Invalid token format provided.');
            return;
        }

        // 检查 github_pat_ 类型 Token 的长度
        if (token.startsWith('github_pat_')) {
            // github_pat_ 格式的 token 长度通常在 100 位以上
            if (token.length < 100) {
                this.ui?.showToast(I18n.t('login.fineGrainedLength'), 'error');
                console.error('[App] github_pat_ token seems to be of invalid length.');
                return;
            }
        } else if (token.startsWith('ghp_')) {
            // ghp_ 格式的 token 长度通常是 40 位
            if (token.length !== 40) {
                this.ui?.showToast(I18n.t('login.tokenLength'), 'error');
                console.error('[App] ghp_ token seems to be of invalid length.');
                return;
            }
        }
        
        console.log('[App] Attempting to login with token format: ', token.startsWith('ghp_') ? 'classic (ghp_)' : 'fine-grained (github_pat_)');
        try {
            this.ui?.showToast(I18n.t('login.validating'), 'info');
            this.api = new GitHubAPI(token);
            const user = await this.api.getMe();
            this.storage.setToken(token);
            this.storage.setUser(user);
            this.storage.addAccount(token, user);
            // 确保当前账号 ID 已设置（addAccount 里已设置，这里双重保险）
            this.storage.set(this.storage.keys.CURRENT_ACCOUNT, this.storage._getAccountId());
            await this.initializeWithToken(token);
            this.ui?.showToast(I18n.t('login.success'), 'success');
        } catch (e) {
            console.error('登录失败:', e);
            let errorMessage = '登录失败';
            if (e.status === 401) {
                errorMessage = 'Token 无效或已过期，请检查并重试';
            } else if (e.status === 403) {
                errorMessage = 'Token 权限不足，请确保拥有 repo 和 workflow 权限';
            } else if (e.message) {
                errorMessage += `: ${e.message}`;
            }
            this.ui?.showToast(errorMessage, 'error');
        }
    }

    async initializeWithToken(token) {
        if (!this.api) this.api = new GitHubAPI(token);
        // 设置限流警告回调
        this.api.onRateLimitWarning = (level, info) => {
            const resetTime = info.reset ? new Date(info.reset * 1000).toLocaleTimeString() : '未知';
            if (level === 'critical') {
                this.ui?.showToast(I18n.t('api.rateLimit').replace('{remaining}', info.remaining).replace('{time}', resetTime), 'error');
            } else {
                this.ui?.showToast(`⚠️ API 剩余 ${info.remaining} 次请求，${resetTime} 重置`, 'warning');
            }
        };
        this.fileManager = new FileManager(this.api, this.storage);
        this.shareManager = new ShareManager(this.api, this.storage);
        // UI 只创建一次，避免重复绑定事件导致 toast/导航重复触发
        if (!this.ui) {
            this.ui = new UI(this);
            window.ui = this.ui;
            window.app = this;
        }

        this.configSync = new ConfigSync(this.api, this.storage);
        this.storage.onConfigChange = () => this.configSync.scheduleSync();

        try { await this.configSync.init(); } catch (e) { console.warn('配置同步初始化失败:', e.message); }

        this.showApp();
        // 更新仓库体积显示
        setTimeout(() => this.updateRepoSizeDisplay(), 1500);

        // 验证 token 有效性（401 说明 token 无效/过期，回登录页）
        try {
            const user = await this.api.getMe();
            this.storage.setUser(user);
        } catch (e) {
            console.warn('[App] 获取用户信息失败:', e.message);
            if (e.status === 401) {
                this.ui?.showToast(I18n.t('login.invalidToken'), 'error');
                this.logout();
                return;
            }
        }
        const user = this.storage.getUser();
        if (user) this.ui.renderUserInfo(user);
        
        // 数据修复 + 实时同步：从 GitHub 获取当前用户的所有 drive-storage-* 仓库
        // 覆盖本地可能混乱的仓库列表，确保数据严格隔离
        if (user && user.login) {
            try {
                const allRepos = await this.api.listRepositories(100, 1);
                const storageRepos = allRepos
                    .filter(r => r.name.startsWith('drive-storage-') && r.owner.login === user.login)
                    .map(r => ({
                        owner: r.owner.login,
                        repo: r.name,
                        name: r.name,
                        description: r.description || '',
                        branch: r.default_branch || 'main',
                        isDefault: false,
                        addedAt: new Date().toISOString()
                    }));
                
                // 按更新时间排序，最新的作为默认仓库
                if (storageRepos.length > 0) {
                    storageRepos[0].isDefault = true;
                }
                
                const oldRepos = this.storage.getRepos();
                if (JSON.stringify(oldRepos) !== JSON.stringify(storageRepos)) {
                    console.log(`[App] 从 GitHub 同步仓库列表: ${oldRepos.length} → ${storageRepos.length} 个存储仓库`);
                    this.storage.setRepos(storageRepos);
                }
                this._repoSizeFailed = false;
            } catch (e) {
                console.warn('[App] 同步仓库列表失败，使用本地缓存:', e.message);
                // 同步失败时，至少清理 owner 不匹配的仓库
                const repos = this.storage.getRepos();
                const validRepos = repos.filter(r => r.owner === user.login);
                if (validRepos.length !== repos.length) {
                    this.storage.setRepos(validRepos);
                }
            }
        }
        // 恢复上次浏览状态
        const restored = this.restoreLastState();
        if (restored) {
            // 已恢复路径和视图，switchView会自动加载文件
        } else {
            await this.loadFiles();
        }
        this.fileManager.syncAllRepoUsage().then(() => this.ui.renderRepoList()).catch(() => {});
    }

    logout() { this.storage.clearToken(); this.storage.setUser(null); location.reload(); }
    
    // 切换账号
    async switchAccount(accountId) {
        // 先保存当前账号的最后浏览状态
        try { this.saveLastState(); } catch(e) {}
        // 严格数据隔离：切换账号前清除当前账号的所有本地缓存
        // 这样新账号会从远程重新读取 config，不会和旧账号数据混淆
        this.storage.clearCurrentAccountData();
        const account = this.storage.setCurrentAccount(accountId);
        if (account) {
            location.reload();
        }
    }
    
    // 删除账号
    removeAccount(accountId) {
        this.storage.removeAccount(accountId);
        // 如果删除的是当前账号，回到登录页
        if (!this.storage.getCurrentAccountId()) {
            this.storage.clearToken();
            this.storage.setUser(null);
            location.reload();
        }
    }

    async loadFiles() {
        if (!this.fileManager) return;
        this.ui.showLoading();
        this.ui.renderBreadcrumb();
        try {
            const files = await this.fileManager.listFiles();
            this.currentFiles = files;
            this.ui.renderFileList(files);
        } catch (e) {
            this.ui.showToast('加载文件失败: ' + e.message, 'error');
            document.getElementById('loading-state')?.classList.add('hidden');
        }
    }

    async navigateTo(path) { 
        this.fileManager.setCurrentPath(path); 
        this.saveLastState();
        await this.loadFiles(); 
    }
    
    // 保存上次浏览状态（路径+视图）
    saveLastState() {
        try {
            const currentPath = this.fileManager.currentPath || '/drive_home';
            // 不保存回收站路径
            if (currentPath.includes('.trash')) return;
            const state = {
                path: currentPath,
                view: this._currentView || 'all-files',
                time: Date.now()
            };
            this.storage.set('last_state', state);
        } catch (e) { /* 忽略 */ }
    }
    
    // 恢复上次浏览状态
    restoreLastState() {
        try {
            const saved = this.storage.get('last_state', null);
            if (!saved) return false;
            const state = saved;
            const view = state.view || 'all-files';
            this._currentView = view;
            if (view === 'all-files') {
                // 文件视图：恢复路径并加载
                if (state.path) {
                    this.fileManager.setCurrentPath(state.path);
                }
                this.loadFiles();
            } else {
                // 其他视图：切换视图会自动加载对应内容
                if (this.ui) this.ui.switchView(view);
            }
            return true;
        } catch (e) { return false; }
    }

    async openFile(file) {
        if (file.isFolder) { await this.navigateTo(file.path); }
        else { this.previewFile(file); }
    }

    async previewFile(file) {
        try {
            this.ui.showToast(I18n.t('file.previewLoading') || '正在加载预览...', 'info');
            let blob = await this.fileManager.getFileBlob(file.path);
            // 文本文件自动检测编码（GBK/UTF-8），避免乱码
            const textExts = ['txt','md','csv','log','json','js','css','html','htm','xml','yaml','yml','ini','conf','py','java','c','cpp','h','go','rs','ts','jsx','tsx','sh','bat','sql'];
            const ext = file.name.split('.').pop().toLowerCase();
            if (textExts.includes(ext)) {
                const buf = await blob.arrayBuffer();
                let text = null;
                // 先尝试 UTF-8（严格模式，失败则抛异常）
                try {
                    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
                } catch {
                    // UTF-8 失败，尝试 GBK
                    try {
                        text = new TextDecoder('gbk').decode(buf);
                    } catch {
                        // GBK 也失败，用默认 UTF-8（带替换字符）
                        text = new TextDecoder('utf-8').decode(buf);
                    }
                }
                // 用 UTF-8 重新编码，加 BOM 确保浏览器识别
                const utf8Buf = new TextEncoder().encode(text);
                const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
                const withBom = new Uint8Array(bom.length + utf8Buf.length);
                withBom.set(bom, 0);
                withBom.set(utf8Buf, bom.length);
                blob = new Blob([withBom], { type: 'text/plain;charset=utf-8' });
            }
            const url = URL.createObjectURL(blob);
            window.open(url, '_blank');
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            this.storage.addToRecent(file.path);
        } catch (e) { this.ui.showToast((I18n.t('file.previewFailed') || '预览失败') + ': ' + e.message, 'error'); }
    }

    async downloadFile(file) {
        try {
            this.ui.showDownloadProgress(file.name);
            await this.fileManager.downloadFile(file.path, (percent, current, total) => {
                this.ui.updateDownloadProgress(percent, current, total);
            });
            this.ui.hideDownloadProgress();
            this.ui.showToast('下载完成', 'success');
        } catch (e) {
            this.ui.hideDownloadProgress();
            this.ui.showToast(I18n.t('file.downloadFailed') + ': ' + e.message, 'error');
        }
    }

    async deleteFile(file, permanent = false) {
        const isInTrash = file.path.startsWith('/drive_home/.trash/');
        const reallyDelete = permanent || isInTrash;
        if (reallyDelete) {
            if (!confirm(`确定要永久删除 "${file.name}" 吗？此操作不可撤销，文件将从 GitHub 仓库彻底删除。`)) return;
        } else {
            if (!confirm(`确定要删除 "${file.name}" 吗？文件将移到回收站，可在 30 天内恢复。`)) return;
        }
        try {
            if (reallyDelete) {
                // 永久删除：删除 GitHub 分片
                if (file.isFolder) {
                    await this.fileManager.deleteFolder(file.path);
                } else {
                    await this.fileManager.deleteFile(file.path);
                }
                this.ui.showToast(`已永久删除: ${file.name}`, 'success');
            } else {
                // 移到回收站：只修改虚拟路径，不删除 GitHub 分片
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const trashPath = `/drive_home/.trash/${timestamp}_${file.name}`;
                this.storage.moveItem(file.path, trashPath);
                this.ui.showToast(`已移到回收站: ${file.name}`, 'success');
            }
            setTimeout(() => this.loadFiles(), 500);
        } catch (e) { this.ui.showToast('删除失败: ' + e.message, 'error'); }
    }
    
    // 从回收站恢复文件
    async restoreFile(file) {
        try {
            // 从回收站路径提取原始文件名（去掉时间戳前缀）
            const trashName = file.path.split('/').pop();
            const originalName = trashName.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/, '');
            const restorePath = `/drive_home/${originalName}`;
            this.storage.moveItem(file.path, restorePath);
            this.ui.showToast(`已恢复: ${originalName}`, 'success');
            setTimeout(() => this.loadFiles(), 500);
        } catch (e) { this.ui.showToast('恢复失败: ' + e.message, 'error'); }
    }

    async deleteFiles(files, permanent = false) {
        if (!files || files.length === 0) return;
        if (files.length === 1) { this.deleteFile(files[0], permanent); return; }
        const hasInTrash = files.some(f => f.path.startsWith('/drive_home/.trash/'));
        const reallyDelete = permanent || hasInTrash;
        if (reallyDelete) {
            if (!confirm(`确定要永久删除选中的 ${files.length} 个项目吗？此操作不可撤销。`)) return;
        } else {
            if (!confirm(`确定要删除选中的 ${files.length} 个项目吗？文件将移到回收站。`)) return;
        }
        try {
            let success = 0, failed = 0;
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            for (const f of files) {
                try {
                    if (reallyDelete) {
                        if (f.isFolder) await this.fileManager.deleteFolder(f.path);
                        else await this.fileManager.deleteFile(f.path);
                    } else {
                        const trashPath = `/drive_home/.trash/${timestamp}_${f.name}`;
                        this.storage.moveItem(f.path, trashPath);
                    }
                    success++;
                } catch (e) { failed++; }
            }
            const msg = failed > 0 ? `已删除 ${success} 个，失败 ${failed} 个` : `已删除 ${success} 个项目`;
            this.ui.showToast(msg, failed > 0 ? 'warning' : 'success');
            this.ui.deselectFile();
            setTimeout(() => this.loadFiles(), 500);
        } catch (e) { this.ui.showToast('删除失败: ' + e.message, 'error'); }
    }

    async renameFile(file, newName) {
        if (!file) file = this.ui.contextMenuTarget;
        if (!newName) newName = document.getElementById('rename-input')?.value?.trim();
        if (!file || !newName) { this.ui.showToast(I18n.t('error.enterNewName'), 'error'); return; }
        try {
            await this.fileManager.renameItem(file.path, newName);
            this.ui.showToast(I18n.t('toast.renameSuccess'), 'success');
            this.ui.closeModal();
            await this.loadFiles();
        } catch (e) { this.ui.showToast('重命名失败: ' + e.message, 'error'); }
    }

    // 移动文件（虚拟路径，只需修改配置）
    async moveFile(file) {
        const files = file ? (Array.isArray(file) ? file : [file]) : (this.ui._moveFiles || []);
        const targetPath = this.ui._moveTargetPath || '';
        if (!files || files.length === 0) { this.ui.showToast(I18n.t('error.selectFiles'), 'error'); return; }
        try {
            let success = 0;
            for (const f of files) {
                const newPath = targetPath ? `/drive_home/${targetPath}/${f.name}` : `/drive_home/${f.name}`;
                if (f.isFolder && (newPath === f.path || newPath.startsWith(f.path + '/'))) continue;
                this.storage.moveItem(f.path, newPath);
                success++;
            }
            this.ui.showToast(`已移动 ${success} 个项目`, 'success');
            this.ui.closeModal();
            await this.loadFiles();
        } catch (e) { this.ui.showToast('移动失败: ' + e.message, 'error'); }
    }

    async moveFileByDrag(file, targetFolderPath) {
        if (!file || !targetFolderPath) return;
        try {
            const fileName = file.name;
            const newPath = `${targetFolderPath}/${fileName}`;
            if (newPath === file.path) return;
            if (file.isFolder && newPath.startsWith(file.path + '/')) {
                this.ui.showToast(I18n.t('error.cannotMoveToSubfolder'), 'error');
                return;
            }
            this.storage.moveItem(file.path, newPath);
            this.ui.showToast(`已移动到 ${targetFolderPath.split('/').pop() || '根目录'}`, 'success');
            await this.loadFiles();
        } catch (e) { this.ui.showToast('移动失败: ' + e.message, 'error'); }
    }

    // 复制文件（下载原文件内容，重新上传到目标位置）
    async copyFile(file) {
        const files = file ? (Array.isArray(file) ? file : [file]) : (this.ui._copyFiles || []);
        const targetPath = this.ui._copyTargetPath || '';
        if (!files || files.length === 0) { this.ui.showToast(I18n.t('error.selectFiles'), 'error'); return; }
        try {
            this.ui.showToast(I18n.t('common.copying'), 'info');
            this.ui.closeModal();
            const targetFullPath = targetPath ? `/drive_home/${targetPath}` : '/drive_home';
            let success = 0;
            for (const f of files) {
                const content = await this.fileManager.getFileContent(f.path);
                const blob = new Blob([content]);
                const fileObj = new File([blob], f.name, { type: 'application/octet-stream' });
                await this.fileManager.uploadFile(fileObj, targetFullPath);
                success++;
            }
            this.ui.showToast(`已复制 ${success} 个项目`, 'success');
            await this.loadFiles();
        } catch (e) { this.ui.showToast('复制失败: ' + e.message, 'error'); }
    }

    async uploadFiles(files) {
        if (!files || files.length === 0) return;
        this.ui.showUploadProgress?.(files);
        try {
            for (let i = 0; i < files.length; i++) {
                await this.fileManager.uploadFile(files[i], this.fileManager.currentPath, (percent) => {
                    this.ui.updateUploadProgress?.(i, percent, files.length);
                });
                this.ui.setUploadSuccess?.(i);
            }
            this.ui.showToast(`成功上传 ${files.length} 个文件`, 'success');
            await this.loadFiles();
            // 显示成功状态 2 秒后自动关闭面板
            setTimeout(() => this.ui.hideUploadProgress?.(), 2000);
        } catch (e) {
            this.ui.showToast(I18n.t('file.uploadFailed') + ': ' + e.message, 'error');
            setTimeout(() => this.ui.hideUploadProgress?.(), 3000);
        }
    }

    async uploadFolder(files) {
        if (!files || files.length === 0) return;
        const items = files.map(f => ({
            file: f,
            relativePath: f.webkitRelativePath || f.name
        }));
        this.ui.showUploadProgress?.(items.map(it => ({ name: it.relativePath })));
        try {
            for (let i = 0; i < items.length; i++) {
                const { file, relativePath } = items[i];
                // 保留完整相对路径（包括外层文件夹名）
                const subPath = relativePath;
                const lastSlash = subPath.lastIndexOf('/');
                const parentPath = lastSlash > 0 ? '/drive_home/' + subPath.substring(0, lastSlash) : '/drive_home';
                // 确保父文件夹存在
                if (parentPath !== '/drive_home') {
                    await this.ensureFolderPath(parentPath);
                }
                await this.fileManager.uploadFile(file, parentPath, (percent) => {
                    this.ui.updateUploadProgress?.(i, percent);
                });
                this.ui.setUploadSuccess?.(i);
            }
            this.ui.showToast(`成功上传 ${items.length} 个文件`, 'success');
            await this.loadFiles();
            setTimeout(() => this.ui.hideUploadProgress?.(), 2000);
        } catch (e) {
            this.ui.showToast(I18n.t('file.uploadFailed') + ': ' + e.message, 'error');
            setTimeout(() => this.ui.hideUploadProgress?.(), 3000);
        }
    }

    async ensureFolderPath(path) {
        const parts = path.replace(/^\/drive_home\/?/, '').split('/').filter(Boolean);
        let current = '/drive_home';
        for (const part of parts) {
            current += '/' + part;
            if (!this.storage.exists(current)) {
                this.storage.putFolder(current);
            }
        }
    }

    async createFolder(name) {
        if (!name) name = document.getElementById('new-folder-name')?.value?.trim();
        if (!name) { this.ui.showToast(I18n.t('error.enterFolderName'), 'error'); return; }
        try {
            await this.fileManager.createFolder(name);
            this.ui.showToast(I18n.t('toast.folderCreated'), 'success');
            this.ui.closeModal();
            await this.loadFiles();
        } catch (e) { this.ui.showToast('创建失败: ' + e.message, 'error'); }
    }

    async shareFiles(files) {
        if (!files) files = this.ui._shareFiles || [];
        if (files.length === 0) { this.ui.showToast(I18n.t('share.noFiles'), 'error'); return; }
        const shareName = document.getElementById('share-name')?.value?.trim() || '';
        const shareDesc = document.getElementById('share-desc')?.value?.trim() || '';
        try {
            this.ui.closeModal();
            const virtualPaths = files.map(f => f.path);
            const result = await this.shareManager.shareByVirtualPaths(virtualPaths, shareName, shareDesc, (percent, msg) => {
                this.ui.showToast(`分享中: ${msg} (${percent}%)`, 'info');
            });
            this.ui.showShareResult?.(result);
        } catch (e) { this.ui.showToast('分享失败: ' + e.message, 'error'); }
    }

    async searchFiles(query) {
        if (!query.trim()) { await this.loadFiles(); return; }
        const searchContent = localStorage.getItem('gd_search_content') === '1';
        const results = this.fileManager.searchFiles(query, searchContent);
        this.currentFiles = results;
        this.ui.renderFileList(results);
    }

    // 收藏/取消收藏
    async toggleStar(file) {
        const isFav = this.storage.toggleFavorite(file.path);
        this.ui.showToast(isFav ? I18n.t('toast.starred') : I18n.t('toast.unstarred'), 'success');
        await this.loadFiles();
    }

    // 最近使用
    // 显示回收站文件
    async showTrashFiles() {
        try {
            const trashPath = '/drive_home/.trash';
            const files = this.storage.listDirectory(trashPath);
            // 回收站视图：显示恢复和永久删除按钮
            this.ui.renderFileList(files, { isTrash: true });
        } catch (e) {
            this.ui.showToast('加载回收站失败: ' + e.message, 'error');
        }
    }
    
    async showRecentFiles() {
        const paths = this.storage.getRecent();
        const vfs = this.storage.getVFS();
        const items = [];
        for (const p of paths) {
            if (vfs.files[p]) items.push({ ...vfs.files[p], path: p, isFile: true });
            else if (vfs.folders[p]) items.push({ ...vfs.folders[p], path: p, isFolder: true });
        }
        this.currentFiles = items;
        this.ui.renderFileList(this.currentFiles);
        this.ui.showToast(I18n.t('toast.recentCount').replace('{count}', items.length), 'info');
    }

    // 收藏文件
    async showStarredFiles() {
        const paths = this.storage.getFavorites();
        const vfs = this.storage.getVFS();
        const items = [];
        for (const p of paths) {
            if (vfs.files[p]) items.push({ ...vfs.files[p], path: p, isFile: true });
            else if (vfs.folders[p]) items.push({ ...vfs.folders[p], path: p, isFolder: true });
        }
        this.currentFiles = items;
        this.ui.renderFileList(this.currentFiles);
        this.ui.showToast(I18n.t('toast.starredCount').replace('{count}', items.length), 'info');
    }

    // 我的分享
    async showShares() {
        const shares = this.storage.getShares();
        this.ui.showShareList?.(shares);
    }

    // 发现分享（搜索公开分享）
    async showExploreShares() {
        this._explorePage = 1;
        this._exploreShares = [];
        this._exploreHasMore = true;
        const cached = this.getCache('gd_cache_explore');
        if (cached && cached.length > 0) {
            this._exploreShares = cached;
            this._explorePage = 2;
            this.ui.renderExploreShares?.(cached, true);
            // 后台静默刷新第一页
            this._refreshExploreCache();
        } else {
            this.ui.showExploreLoading?.();
            await this.loadMoreExploreShares();
        }
    }

    async _refreshExploreCache() {
        try {
            const result = await this.shareManager.searchShares(1, 30);
            if (result.shares.length > 0) {
                this._exploreShares = result.shares;
                this._exploreHasMore = result.hasMore;
                this._explorePage = 2;
                this.setCache('gd_cache_explore', result.shares);
                this.ui.renderExploreShares?.(result.shares, result.hasMore);
            }
        } catch (e) {
            console.debug('后台刷新分享失败:', e.message);
        }
    }

    async loadMoreExploreShares() {
        if (!this._exploreHasMore) return;
        const isFirstPage = this._explorePage === 1;
        try {
            const result = await this.shareManager.searchShares(this._explorePage, 30);
            this._exploreShares = this._exploreShares.concat(result.shares);
            this._exploreHasMore = result.hasMore;
            this._explorePage++;
            this.ui.renderExploreShares?.(this._exploreShares, this._exploreHasMore);
            if (isFirstPage && result.shares.length > 0) {
                this.setCache('gd_cache_explore', result.shares);
            }
        } catch (e) {
            this.ui.showToast('加载分享失败: ' + e.message, 'error');
            this.ui.renderExploreShares?.(this._exploreShares, false);
        }
    }

    // ==================== 后端服务配置 ====================
    // ==================== 仓库体积监控 ====================
    
    async getRepoSize() {
        // 如果之前已经失败过，直接返回，避免重复请求
        if (this._repoSizeFailed) return null;
        try {
            const owner = this.storage.getUser()?.login;
            if (!owner) return null;
            
            // 优先访问存储仓库（drive-storage-*），而不是默认的 github_drive
            const repos = this.storage.getRepos();
            if (repos.length === 0) return null;
            
            // 计算所有存储仓库的总体积
            let totalSize = 0;
            let repoCount = 0;
            for (const repo of repos) {
                try {
                    const repoInfo = await this.api.getRepository(repo.owner, repo.repo);
                    totalSize += repoInfo.size || 0;
                    repoCount++;
                } catch (e) {
                    console.debug('获取仓库体积失败:', repo.repo, e.message);
                }
            }
            
            if (repoCount === 0) return null;
            
            return {
                size: totalSize, // KB
                sizeMB: (totalSize / 1024).toFixed(1),
                sizeGB: (totalSize / (1024 * 1024)).toFixed(2),
                name: `${repoCount} 个存储仓库`,
                full_name: `${owner}/drive-storage-*`
            };
        } catch (e) {
            this._repoSizeFailed = true;
            console.debug('获取仓库体积失败:', e.message);
            return null;
        }
    }
    
    async updateRepoSizeDisplay() {
        const info = await this.getRepoSize();
        const el = document.getElementById('repo-size-display');
        if (!el || !info) return;
        const sizeMB = parseFloat(info.sizeMB);
        let color = '#6b7280';
        let warning = '';
        if (sizeMB > 900) {
            color = '#dc2626';
            warning = ' ⚠️ 接近上限';
        } else if (sizeMB > 500) {
            color = '#f59e0b';
            warning = ' ⚠️';
        }
        el.innerHTML = `<span style="color:${color};">📦 ${info.sizeMB} MB${warning}</span>`;
        el.title = `仓库：${info.full_name}
体积：${info.sizeMB} MB (${info.sizeGB} GB)
GitHub 建议不超过 1 GB`;
        if (sizeMB > 900) {
            this.ui?.showToast(`⚠️ 仓库体积已达 ${info.sizeMB} MB，接近 1 GB 上限！建议清理历史记录或迁移部分文件`, 'error');
        }
    }

    // ==================== 数据导出/导入 ====================
    
    exportBackup() {
        try {
            const data = this.storage.exportData();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `github_drive_backup_${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            this.ui?.showToast(I18n.t('toast.backupExported'), 'success');
        } catch (e) {
            this.ui?.showToast('导出失败: ' + e.message, 'error');
        }
    }
    
    importBackup(file) {
        if (!file) {
            // 触发文件选择
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = (e) => {
                if (e.target.files[0]) this.importBackup(e.target.files[0]);
            };
            input.click();
            return;
        }
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!confirm(I18n.t('backup.importConfirm'))) return;
                this.storage.importData(data);
                this.ui?.showToast(I18n.t('backup.imported'), 'success');
                setTimeout(() => location.reload(), 1500);
            } catch (err) {
                this.ui?.showToast(I18n.t('backup.importFailed'), 'error');
            }
        };
        reader.readAsText(file);
    }

    getBackendConfig() {
        try {
            return JSON.parse(localStorage.getItem('gd_backend_config') || '{}');
        } catch { return {}; }
    }

    saveBackendConfig(config) {
        localStorage.setItem('gd_backend_config', JSON.stringify(config));
    }

    async backendRequest(data) {
        const config = this.getBackendConfig();
        const baseUrl = config.url || 'http://localhost:8787';
        const token = config.token || '';
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['X-Auth-Token'] = token;
        const resp = await fetch(baseUrl + data.path, {
            method: data.method || 'GET',
            headers,
            body: data.body ? JSON.stringify(data.body) : undefined
        });
        return resp.json();
    }

    // ==================== 插件系统 ====================
    PLUGIN_REPO = 'Cool-zimo/github_drive_plugins';
    PLUGIN_REPO_BRANCH = 'main';

    getInstalledPlugins() {
        try { return JSON.parse(localStorage.getItem('gd_plugins') || '{}'); }
        catch { return {}; }
    }

    saveInstalledPlugins(plugins) {
        localStorage.setItem('gd_plugins', JSON.stringify(plugins));
    }

    CACHE_TTL = 5 * 60 * 1000; // 缓存5分钟

    getCache(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            if (Date.now() - cache.timestamp > this.CACHE_TTL) return null;
            return cache.data;
        } catch { return null; }
    }

    setCache(key, data) {
        try { localStorage.setItem(key, JSON.stringify({ data, timestamp: Date.now() })); } catch {}
    }

    // 搜索第三方插件（众筹模式，搜索 GD-Plugin- 开头的仓库）
    async searchCommunityPlugins(page = 1, perPage = 30) {
        // 命名格式：GD-Plugin-{项目名}-{开发者}
        const result = await this.api.searchRepositories('GD-Plugin in:name', page, perPage);
        const repos = result.items || [];
        const plugins = [];
        // 严格命名格式正则
        const nameRegex = /^GD-Plugin-[^-]+-[^-]+$/;
        for (const repo of repos) {
            try {
                // 跳过官方仓库
                if (repo.full_name === 'Cool-zimo/github_drive_plugins') continue;
                // 1. 严格检查仓库名格式
                if (!nameRegex.test(repo.name)) {
                    console.debug('跳过命名格式不符的仓库:', repo.name);
                    continue;
                }
                // 2. 检查是否空仓库（size=0 或没有默认分支）
                if (repo.size === 0 || !repo.default_branch) {
                    console.debug('跳过空仓库:', repo.full_name);
                    continue;
                }
                // 3. 必须有 plugin.json
                let manifest = null;
                let entryFile = null;
                try {
                    const raw = await this.api.getFileRaw(repo.owner.login, repo.name, 'plugin.json', repo.default_branch);
                    manifest = JSON.parse(new TextDecoder('utf-8').decode(raw));
                    entryFile = manifest?.file;
                } catch {
                    console.debug('跳过无plugin.json的仓库:', repo.full_name);
                    continue;
                }
                // 4. 入口文件必须在 plugin.json 中指定
                if (!entryFile) {
                    console.debug('跳过plugin.json未指定入口文件的仓库:', repo.full_name);
                    continue;
                }
                const plugin = {
                    id: 'community-' + repo.full_name.replace('/', '-'),
                    name: manifest?.name || repo.name,
                    description: manifest?.description || repo.description || '暂无描述',
                    author: manifest?.author || repo.owner.login,
                    version: manifest?.version || '1.0.0',
                    icon: manifest?.icon || '🧩',
                    type: manifest?.type || 'plugin',
                    file: entryFile,
                    community: true,
                    repoUrl: repo.html_url,
                    repoFullName: repo.full_name,
                    stars: repo.stargazers_count,
                    updatedAt: repo.updated_at,
                    hasManifest: !!manifest
                };
                plugins.push(plugin);
            } catch (e) {
                console.debug('跳过插件仓库:', repo.full_name, e.message);
            }
        }
        return { plugins, total: result.total_count || 0, hasMore: repos.length >= perPage };
    }

    // 安装第三方插件
    async installCommunityPlugin(pluginInfo) {
        try {
            this.ui.showToast('正在安装 ' + pluginInfo.name + '...', 'info');
            const [owner, repo] = pluginInfo.repoFullName.split('/');
            let data;
            try {
                data = await this.api.getFileRaw(owner, repo, pluginInfo.file, 'main');
            } catch (e) {
                this.ui.showToast('安装失败：入口文件 "' + pluginInfo.file + '" 不存在，请去插件仓库确认', 'error');
                window.open(pluginInfo.repoUrl, '_blank');
                return;
            }
            const html = new TextDecoder('utf-8').decode(data);
            const installed = this.getInstalledPlugins();
            installed[pluginInfo.id] = {
                ...pluginInfo,
                html,
                installedAt: new Date().toISOString()
            };
            this.saveInstalledPlugins(installed);
            this.ui.showToast(pluginInfo.name + ' 安装成功', 'success');
            this.showPluginMarket();
        } catch (e) {
            this.ui.showToast('安装失败: ' + e.message, 'error');
        }
    }

    async showPluginMarket() {
        const cached = this.getCache('gd_cache_plugins');
        const installed = this.getInstalledPlugins();
        if (cached) {
            this.ui.renderPluginMarket?.(cached, installed);
            // 后台静默更新
            this._refreshPluginCache();
        } else {
            this.ui.showPluginLoading?.();
            await this._refreshPluginCache();
        }
    }

    async _refreshPluginCache() {
        try {
            const [owner, repo] = this.PLUGIN_REPO.split('/');
            const data = await this.api.getFileRaw(owner, repo, 'plugins.json', this.PLUGIN_REPO_BRANCH);
            const manifestText = new TextDecoder('utf-8').decode(data);
            const manifest = JSON.parse(manifestText);
            const plugins = manifest.plugins || [];
            this.setCache('gd_cache_plugins', plugins);
            const installed = this.getInstalledPlugins();
            this.ui.renderPluginMarket?.(plugins, installed);
        } catch (e) {
            if (!this.getCache('gd_cache_plugins')) {
                this.ui.showToast('加载插件市场失败: ' + e.message, 'error');
                this.ui.renderPluginMarket?.([], {});
            }
        }
    }

    async installPlugin(pluginInfo) {
        try {
            this.ui.showToast('正在安装 ' + pluginInfo.name + '...', 'info');
            const [owner, repo] = this.PLUGIN_REPO.split('/');
            const data = await this.api.getFileRaw(owner, repo, pluginInfo.file, this.PLUGIN_REPO_BRANCH);
            const html = new TextDecoder('utf-8').decode(data);
            const installed = this.getInstalledPlugins();
            installed[pluginInfo.id] = {
                ...pluginInfo,
                html,
                installedAt: new Date().toISOString()
            };
            this.saveInstalledPlugins(installed);
            this.ui.showToast(pluginInfo.name + ' 安装成功', 'success');
            this.showPluginMarket();
        } catch (e) {
            this.ui.showToast('安装失败: ' + e.message, 'error');
        }
    }

    uninstallPlugin(pluginId) {
        const installed = this.getInstalledPlugins();
        const plugin = installed[pluginId];
        if (!plugin) return;
        if (!confirm('确定卸载 "' + plugin.name + '" 吗？')) return;
        delete installed[pluginId];
        this.saveInstalledPlugins(installed);
        this.ui.showToast('已卸载 ' + plugin.name, 'success');
        this.showPluginMarket();
    }

    runPlugin(pluginId) {
        const installed = this.getInstalledPlugins();
        const plugin = installed[pluginId];
        if (!plugin) { this.ui.showToast(I18n.t('plugin.notInstalled'), 'error'); return; }
        this.ui.showPluginRunner?.(plugin);
    }

    // 插件 API（postMessage 通信）
    handlePluginMessage(event, pluginId) {
        const data = event.data;
        if (!data || data.type !== 'gd-api') return;
        const { id, action, data: payload } = data;
        const respond = (result, error) => {
            event.source.postMessage({ type: 'gd-response', id, result, error }, '*');
        };

        (async () => {
            try {
                switch (action) {
                    case 'listFiles': {
                        const path = payload.path || '/drive_home';
                        const items = this.storage.listDirectory(path);
                        respond(items.map(f => ({
                            name: f.name, path: f.path,
                            isFolder: !!f.isFolder, size: f.size || 0
                        })));
                        break;
                    }
                    case 'downloadFile': {
                        const blob = await this.fileManager.getFileBlob(payload.path);
                        const text = await blob.text();
                        respond(text);
                        break;
                    }
                    case 'uploadFile': {
                        const { name, content, path } = payload;
                        const blob = new Blob([content], { type: 'application/octet-stream' });
                        const file = new File([blob], name);
                        await this.fileManager.uploadFile(file, path || '/drive_home');
                        await this.loadFiles();
                        respond({ success: true });
                        break;
                    }
                    case 'showToast':
                        this.ui.showToast(payload.message, payload.type || 'info');
                        respond({ success: true });
                        break;
                    case 'getCurrentPath':
                        respond(this.fileManager.currentPath);
                        break;
                    case 'getToken':
                        respond(this.storage.getToken());
                        break;
                    case 'getBackendConfig':
                        respond(this.getBackendConfig());
                        break;
                    case 'backendRequest': {
                        const config = this.getBackendConfig();
                        const baseUrl = config.url || 'http://localhost:8787';
                        const token = config.token || '';
                        const headers = { 'Content-Type': 'application/json' };
                        if (token) headers['X-Auth-Token'] = token;
                        const resp = await fetch(baseUrl + (payload.path || '/'), {
                            method: payload.method || 'GET',
                            headers,
                            body: payload.body ? JSON.stringify(payload.body) : undefined
                        });
                        const text = await resp.text();
                        try { respond(JSON.parse(text)); } catch { respond(text); }
                        break;
                    }
                    default:
                        respond(null, '未知 API: ' + action);
                }
            } catch (e) {
                respond(null, e.message);
            }
        })();
    }


    async deleteShare(id) {
        const share = this.storage.getShares().find(s => s.id === id);
        if (!share) return;
        if (!confirm(I18n.t('share.deleteConfirm').replace('{name}', share.description || I18n.t('share.unnamed')))) return;
        try {
            await this.shareManager.deleteShare(share.repoName);
            this.ui.showToast(I18n.t('share.deleted'), 'success');
            this.showShares();
        } catch (e) {
            this.ui.showToast('删除失败: ' + e.message, 'error');
        }
    }
}

let app = null;
let ui = null;

document.addEventListener('DOMContentLoaded', () => {
    app = new App();
    // GitHub OAuth 登录按钮
    // 在 DOM 加载完成后初始化 UI，确保 UI 绑定的元素已存在于页面中
    app.ui = new UI(app);
    window.ui = app.ui;
    window.app = app;
    ui = app.ui;
    // 同步检查本地 token：有则立即显示应用界面，避免刷新时闪一下登录页
    if (app.storage.getToken()) {
        app.showApp();
    }
    app.init().catch(e => {
        console.error('初始化失败:', e);
        app.showLogin();
        app.ui?.showToast('应用初始化失败: ' + e.message, 'error');
    });
});










