/**
 * 分享模块
 * 创建公开仓库 + GitHub Pages 下载页面，实现文件分享
 */
class ShareManager {
    constructor(api, storage) {
        this.api = api;
        this.storage = storage;
    }

    // 判断是否为文本文件
    isTextFile(name) {
        const textExts = ['txt','md','csv','log','json','js','css','html','htm','xml','yaml','yml','ini','conf','py','java','c','cpp','h','go','rs','ts','jsx','tsx','sh','bat','sql','svg'];
        const ext = name.split('.').pop().toLowerCase();
        return textExts.includes(ext);
    }

    /**
     * 通过虚拟路径分享文件（自动合并分片）
     */
    async shareByVirtualPaths(virtualPaths, shareName = '', description = '', onProgress = null) {
        const fileObjects = [];
        for (const vp of virtualPaths) {
            const fileInfo = this.storage.getFile(vp);
            if (!fileInfo) { console.warn('[Share] 文件不存在:', vp); continue; }
            const parts = [];
            for (const chunk of fileInfo.chunks) {
                const c = await this.api.getFileRaw(chunk.owner, chunk.repo, chunk.path, chunk.branch);
                parts.push(c);
            }
            // 合并分片字节
            const totalLen = parts.reduce((sum, p) => sum + (p.length || 0), 0);
            const merged = new Uint8Array(totalLen);
            let off = 0;
            for (const p of parts) { merged.set(p, off); off += p.length; }
            // 文本文件解码为字符串，二进制文件保留原始字节
            if (this.isTextFile(fileInfo.name)) {
                fileObjects.push({ path: fileInfo.name, content: new TextDecoder('utf-8').decode(merged), size: fileInfo.size });
            } else {
                fileObjects.push({ path: fileInfo.name, arrayBuffer: merged.buffer, size: fileInfo.size, isBinary: true });
            }
        }
        if (fileObjects.length === 0) throw new Error(I18n.t('share.noFiles'));
        return await this.shareFiles(fileObjects, shareName, description, onProgress);
    }

    /**
     * 分享文件
     * @param {Array} files - 要分享的文件列表 [{owner, repo, path, name, branch, sha}]
     * @param {string} shareName - 分享名称（用于仓库名）
     * @param {string} description - 分享描述
     * @param {Function} onProgress - 进度回调
     * @returns {Promise<{repoName, shareUrl, files}>}
     */
    async shareFiles(files, shareName = '', description = '', onProgress = null) {
        const username = await this.api.getUsername();
        const timestamp = Date.now().toString(36);
        // 标准命名格式：gd-share-{name}-{timestamp}，方便 GitHub 搜索
        const repoName = shareName
            ? `gd-share-${shareName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}-${timestamp}`
            : `gd-share-${timestamp}`;

        if (onProgress) onProgress(10, I18n.t('share.creatingRepo'));

        // 1. 创建公开仓库
        const repo = await this.api.createRepository(repoName, {
            description: description || I18n.t('share.pageDesc'),
            private: false,
            autoInit: true
        });

        // 等待仓库初始化
        await this.sleep(2000);

        if (onProgress) onProgress(30, '复制分享文件...');

        // 2. 复制文件到分享仓库
        const fileObjects = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                let content;
                if (file.content !== undefined) {
                    // 内容已由调用方提供（如 shareByVirtualPaths 已下载合并分片）
                    content = file.content;
                } else {
                    // 从原始仓库下载
                    const raw = await this.api.getFileRaw(file.owner, file.repo, file.path, file.branch);
                    const fname = file.name || file.path;
                    if (this.isTextFile(fname)) {
                        content = new TextDecoder('utf-8').decode(raw);
                    } else {
                        // 二进制文件保留原始字节
                        fileObjects.push({ path: fname, arrayBuffer: raw.buffer, size: file.size || raw.length, isBinary: true });
                        continue;
                    }
                }
                fileObjects.push({
                    path: file.name || file.path,
                    content
                });
            } catch (e) {
                console.warn(`复制文件 ${file.name || file.path} 失败:`, e);
            }
            if (onProgress) onProgress(30 + Math.round((i + 1) / files.length * 30), `复制文件 ${i + 1}/${files.length}`);
        }

        if (fileObjects.length === 0) {
            throw new Error('没有成功复制任何文件');
        }

        // 3. 生成下载页面
        const downloadPage = this.generateDownloadPage(repoName, description, fileObjects, username);
        fileObjects.push({
            path: 'index.html',
            content: downloadPage
        });

        // 添加 README
        fileObjects.push({
            path: 'README.md',
            content: this.generateReadme(repoName, description, fileObjects, username)
        });
        // 添加标准分享元数据（用于搜索和发现）
        const shareMeta = {
            version: '1.0',
            type: 'github-drive-share',
            name: shareName || repoName,
            description: description || '',
            author: username,
            createdAt: new Date().toISOString(),
            fileCount: fileObjects.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js').length,
            files: fileObjects.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js').map(f => ({ name: f.path, size: f.size || 0 }))
        };
        fileObjects.push({
            path: 'share.json',
            content: JSON.stringify(shareMeta, null, 2)
        });
        // Pages 生效探针（script 标签加载，不受 CORS 限制）
        fileObjects.push({
            path: 'status.js',
            content: 'window.__githubDrivePagesReady = true;'
        });

        if (onProgress) onProgress(70, I18n.t('share.uploadingFiles'));

        // 4. 批量提交文件
        await this.api.batchUploadFiles(
            username,
            repoName,
            fileObjects,
            `Shared ${fileObjects.length - 2} files`,
            'main'
        );

        if (onProgress) onProgress(85, I18n.t('share.enablingPages'));

        // 5. 启用 GitHub Pages
        try {
            await this.api.enablePages(username, repoName, 'main', '/');
            // 请求构建
            await this.api.requestPageBuild(username, repoName).catch(() => {});
        } catch (e) {
            console.warn('启用 GitHub Pages 失败:', e);
        }

        if (onProgress) onProgress(100, I18n.t('share.done'));

        const shareUrl = this.api.getPagesUrl(username, repoName);
        const result = {
            repoName,
            shareUrl,
            repoUrl: this.api.getRepoUrl(username, repoName),
            files: fileObjects.filter(f => !['index.html', 'README.md', 'status.js', 'share.json'].includes(f.path)).map(f => ({ name: f.path })),
            createdAt: new Date().toISOString()
        };

        // 保存分享记录
        this.storage.addShare(result);

        return result;
    }

    /**
     * 生成下载页面 HTML
     */
    generateDownloadPage(repoName, description, files, username) {
        const fileList = files.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js');
        // 用 Pages 相对路径，分段编码（保留 / 分隔符），国内访问更快
        const filesJson = JSON.stringify(fileList.map(f => ({
            name: f.path,
            url: './' + f.path.split('/').map(encodeURIComponent).join('/')
        })));

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${description || I18n.t('share.pageTitle')} - GitHub Drive</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            width: 100%;
            max-width: 600px;
            overflow: hidden;
        }
        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 32px;
            text-align: center;
            position: relative;
        }
        .header-icon { font-size: 48px; margin-bottom: 12px; }
        .header h1 { font-size: 24px; margin-bottom: 8px; }
        .header p { opacity: 0.9; font-size: 14px; }
        .lang-switch { position: absolute; top: 16px; right: 16px; background: rgba(255,255,255,0.2); color: white; border: 1px solid rgba(255,255,255,0.3); padding: 6px 12px; border-radius: 20px; cursor: pointer; font-size: 12px; backdrop-filter: blur(10px); }
        .lang-switch:hover { background: rgba(255,255,255,0.3); }
        .content { padding: 24px; }
        .file-list { list-style: none; }
        .file-item {
            display: flex;
            align-items: center;
            padding: 14px 16px;
            border: 1px solid #e5e7eb;
            border-radius: 10px;
            margin-bottom: 10px;
            transition: all 0.2s;
            cursor: pointer;
        }
        .file-item:hover {
            border-color: #667eea;
            background: #f8f7ff;
            transform: translateY(-1px);
        }
        .file-icon { font-size: 28px; margin-right: 14px; }
        .file-info { flex: 1; min-width: 0; }
        .file-name {
            font-weight: 600;
            font-size: 14px;
            color: #1f2937;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .file-size { font-size: 12px; color: #6b7280; margin-top: 2px; }
        .download-btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: background 0.2s;
            flex-shrink: 0;
        }
        .download-btn:hover { background: #5a67d8; }
        .download-all {
            width: 100%;
            margin-top: 16px;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s;
        }
        .download-all:hover { transform: translateY(-1px); }
        .promo-card {
            margin-top: 20px;
            padding: 20px;
            background: linear-gradient(135deg, #f8f7ff 0%, #eef2ff 100%);
            border: 1px solid #e0e7ff;
            border-radius: 12px;
            text-align: center;
        }
        .promo-icon { font-size: 32px; margin-bottom: 8px; }
        .promo-title {
            font-size: 16px;
            font-weight: 700;
            color: #4338ca;
            margin-bottom: 6px;
        }
        .promo-desc {
            font-size: 13px;
            color: #6366f1;
            margin-bottom: 14px;
            line-height: 1.5;
        }
        .promo-btn {
            display: inline-block;
            padding: 10px 24px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 600;
            transition: transform 0.2s, box-shadow 0.2s;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        }
        .promo-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(102, 126, 234, 0.5);
        }
        .footer {
            padding: 16px 24px;
            border-top: 1px solid #e5e7eb;
            text-align: center;
            font-size: 12px;
            color: #9ca3af;
        }
        .footer a { color: #667eea; text-decoration: none; }
        .empty { text-align: center; padding: 40px; color: #9ca3af; }
        .loading-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 40px 20px;
            gap: 12px;
            color: #9ca3af;
            font-size: 14px;
        }
        .spinner {
            width: 28px;
            height: 28px;
            border: 3px solid #e5e7eb;
            border-top-color: #667eea;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-icon">📦</div>
            <h1>${description || '<span data-i18n="page.title">File Share</span>'}</h1>
            <p>${fileList.length} files · Shared via GitHub Drive</p>
            <button class="lang-switch" onclick="toggleLang()" title="切换语言">🌐 EN / 中</button>
        </div>
        <div class="content">
            <ul class="file-list" id="fileList">
                <li class="loading-state"><div class="spinner"></div><span data-i18n="loading">Loading files...</span></li>
            </ul>
            <button class="download-all" onclick="downloadAll()"><span data-i18n="downloadAll">⬇️ Download All</span></button>
            
            <div class="promo-card">
                <div class="promo-icon">📁✨</div>
                <div class="promo-title"><span data-i18n="promo.title">Want unlimited cloud storage with GitHub?</span></div>
                <div class="promo-desc" data-i18n="promo.desc">Turn your GitHub repos into a private cloud drive<br>Multi-repo management, smart storage allocation, one-click sharing</div>
                <a href="https://${username}.github.io/github_drive" target="_blank" class="promo-btn"><span data-i18n="promo.btn">🚀 Use GitHub Drive Now</span></a>
            </div>
        </div>
        <div class="footer">
            <span data-i18n="footer.powered">Powered by</span> <a href="https://${username}.github.io/github_drive" target="_blank">GitHub Drive</a> · <span data-i18n="footer.stored">Stored on GitHub</span>
        </div>
    </div>
    <script>
        const files = ${filesJson};
        const fileList = document.getElementById('fileList');

        function getFileIcon(name) {
            const ext = name.split('.').pop().toLowerCase();
            const icons = {
                jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',svg:'🖼️',webp:'🖼️',
                mp4:'🎬',avi:'🎬',mov:'🎬',mkv:'🎬',webm:'🎬',
                mp3:'🎵',wav:'🎵',flac:'🎵',aac:'🎵',ogg:'🎵',
                pdf:'📕',doc:'📘',docx:'📘',xls:'📗',xlsx:'📗',ppt:'📙',pptx:'📙',
                txt:'📄',md:'📝',zip:'📦',rar:'📦','7z':'📦',
                js:'📜',py:'🐍',html:'🌐',css:'🎨',json:'📋',
                exe:'⚙️',dmg:'💿',apk:'📱'
            };
            return icons[ext] || '📄';
        }

        function formatSize(bytes) {
            if (!bytes) return '';
            const k = 1024;
            const sizes = ['B','KB','MB','GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
        }

        fileList.innerHTML = '';
        files.forEach(file => {
            const li = document.createElement('li');
            li.className = 'file-item';
            li.onclick = () => window.open(file.url, '_blank');
            li.innerHTML = \`
                <span class="file-icon">\${getFileIcon(file.name)}</span>
                <div class="file-info">
                    <div class="file-name">\${file.name}</div>
                    <div class="file-size">\${file.size ? formatSize(file.size) : '<span data-i18n=\'clickDownload\'>Click to download</span>'}</div>
                </div>
                <button class="download-btn" onclick="event.stopPropagation(); window.open('\\\${file.url}', '_blank')"><span data-i18n="download">Download</span></button>
            \`;
            fileList.appendChild(li);
        });

        function downloadAll() {
            files.forEach((file, i) => {
                setTimeout(() => window.open(file.url, '_blank'), i * 300);
            });
        }

        // 语言切换
        const translations = {
            en: {
                'page.title': 'File Share',
                'promo.desc': 'Turn your GitHub repos into a private cloud drive<br>Multi-repo management, smart storage allocation, one-click sharing',
                'footer.powered': 'Powered by',
                'footer.stored': 'Stored on GitHub',
                'loading': 'Loading files...',
                'downloadAll': '⬇️ Download All',
                'download': 'Download',
                'clickDownload': '<span data-i18n=\'clickDownload\'>Click to download</span>',
                'promo.title': 'Want unlimited cloud storage with GitHub?',
                'promo.btn': '🚀 Use GitHub Drive Now'
            },
            zh: {
                'page.title': '文件分享',
                'promo.desc': 'GitHub Drive 把你的 GitHub 仓库变成私人云盘<br>支持多仓库统一管理、智能容量分配、一键分享',
                'footer.powered': '由',
                'footer.stored': '存储于 GitHub',
                'loading': '加载文件中...',
                'downloadAll': '⬇️ 下载全部文件',
                'download': '下载',
                'clickDownload': '点击下载',
                'promo.title': '也想用 GitHub 当无限云盘？',
                'promo.btn': '🚀 立即使用 GitHub Drive'
            }
        };
        let currentLang = localStorage.getItem('gd_share_lang') || 'en';
        function applyLang(lang) {
            currentLang = lang;
            localStorage.setItem('gd_share_lang', lang);
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (translations[lang][key]) el.innerHTML = translations[lang][key];
            });
            document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
        }
        function toggleLang() {
            applyLang(currentLang === 'en' ? 'zh' : 'en');
        }
        // 初始化语言
        applyLang(currentLang);
    </script>
</body>
</html>`;
    }

    /**
     * 生成 README
     */
    generateReadme(repoName, description, files, username) {
        const fileList = files.filter(f => f.path !== 'index.html' && f.path !== 'README.md' && f.path !== 'status.js');
        let md = `# ${description || I18n.t('share.pageTitle')}\n\n`;
        md += `> 通过 [GitHub Drive](https://${username}.github.io/github_drive) 分享的文件\n\n`;
        md += `## 文件列表\n\n`;
        fileList.forEach(f => {
            md += `- [${f.path}](./${encodeURIComponent(f.path)})\n`;
        });
        md += `\n---\n*由 GitHub Drive 自动生成*`;
        return md;
    }

    /**
     * 获取分享的文件列表（从分享仓库读取）
     */
    async getShareFiles(repoName) {
        const username = await this.api.getUsername();
        const contents = await this.api.getDirectoryContents(username, repoName, '', 'main');
        return contents.filter(item =>
            item.type === 'file' &&
            item.name !== 'index.html' &&
            item.name !== 'README.md' &&
            item.name !== '.gitkeep'
        );
    }

    /**
     * 删除分享（删除仓库）
     */
    async deleteShare(repoName) {
        const username = await this.api.getUsername();
        await this.api.deleteRepository(username, repoName);
        // 从本地记录移除
        const shares = this.storage.getShares().filter(s => s.repoName !== repoName);
        this.storage.set(this.storage.keys.SHARES, shares);
    }

    /**
     * 搜索公开分享（通过标准命名格式 gd-share- 搜索）
     * @param {number} page - 页码
     * @param {number} perPage - 每页数量
     * @returns {Promise<{shares: Array, total: number, hasMore: boolean}>}
     */
    async searchShares(page = 1, perPage = 30) {
        const result = await this.api.searchRepositories('gd-share in:name', page, perPage);
        const repos = result.items || [];
        const shares = [];

        for (const repo of repos) {
            try {
                // 尝试读取 share.json 验证是否是标准分享
                const meta = await this.api.getFileRaw(repo.owner.login, repo.name, 'share.json', repo.default_branch || 'main');
                const metaText = new TextDecoder('utf-8').decode(meta);
                const metaJson = JSON.parse(metaText);
                if (metaJson.type === 'github-drive-share') {
                    shares.push({
                        repoName: repo.name,
                        owner: repo.owner.login,
                        name: metaJson.name || repo.name,
                        description: metaJson.description || repo.description || '',
                        author: metaJson.author || repo.owner.login,
                        avatar: repo.owner.avatar_url,
                        fileCount: metaJson.fileCount || 0,
                        files: metaJson.files || [],
                        createdAt: metaJson.createdAt || repo.created_at,
                        updatedAt: repo.updated_at,
                        stars: repo.stargazers_count,
                        pagesUrl: `https://${repo.owner.login}.github.io/${repo.name}/`,
                        repoUrl: repo.html_url
                    });
                }
            } catch (e) {
                // 没有 share.json 或格式不对，跳过
                console.debug('[Share] 跳过非标准分享仓库:', repo.name, e.message);
            }
        }

        return {
            shares,
            total: result.total_count || 0,
            hasMore: page * perPage < (result.total_count || 0)
        };
    }

    /**
     * 工具：休眠
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
