/**
 * 统一图标集（SVG）
 *
 * 为什么不用 emoji：
 *   emoji 由各操作系统的字体渲染，同一字符在 Windows / macOS / Android /
 *   不同浏览器上字形、颜色、甚至语义都不同（📁 在部分环境显示为蓝色，
 *   部分为黄色；🗑️ 在旧 Windows 上显示为方框）。
 *   而且 emoji 无法跟随主题变色，在暗色模式下会突兀。
 *
 * 为什么用内联 SVG 而不是图标字体：
 *   · 矢量，任意尺寸清晰
 *   · currentColor 自动跟随文字色 / 主题
 *   · 不需要额外网络请求，不依赖 CDN
 *   · 可直接用 CSS 控制大小与颜色
 *
 * 本文件在 GitHub Drive 与仓鼠两个应用中各存一份，内容完全一致。
 */
(function (global) {
    'use strict';

    // 每个图标：24x24 视口，stroke 线条风格（与 GitHub Primer 视觉一致）
    // 只存内部图形，外层 <svg> 由 get() 统一包裹
    var P = {
        // ---- 文件与文件夹 ----
        folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        folderOpen: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M2 14l3.5-5.5a2 2 0 0 1 1.7-.9h13.6a1 1 0 0 1 .85 1.5L18 15"/>',
        file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
        fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
        fileCode: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polyline points="10 12 8 14 10 16"/><polyline points="14 12 16 14 14 16"/>',
        fileImage: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><circle cx="12" cy="14" r="2.5"/><path d="M8.5 19l3-3.5 2 2 2.5-3 3 4.5"/>',
        fileAudio: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M11 12.5v5"/><path d="M9.5 13.5v3"/><path d="M12.5 13.5v3"/><path d="M14 14v2"/>',
        fileVideo: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><polygon points="10 12 15 14.5 10 17"/>',
        fileArchive: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="11" x2="12" y2="17"/><polyline points="9.5 13.5 12 11 14.5 13.5"/>',

        // ---- 操作 ----
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
        trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
        edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
        copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
        move: '<polyline points="15 18 21 12 15 6"/><line x1="21" y1="12" x2="3" y2="12"/>',
        star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
        search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
        refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
        x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>',

        // ---- 导航与状态 ----
        home: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
        grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
        list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
        clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
        history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15.5 14"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        unlock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
        globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
        cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
        zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
        package: '<line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
        book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
        code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
        external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
        chevronRight: '<polyline points="9 18 15 12 9 6"/>',
        chevronDown: '<polyline points="6 9 12 15 18 9"/>',
        chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
        arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
        arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
        moreH: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
        alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
        info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
        help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
        filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
        sort: '<line x1="4" y1="6" x2="16" y2="6"/><line x1="4" y1="12" x2="14" y2="12"/><line x1="4" y1="18" x2="10" y2="18"/>',
        db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
        terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
        link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',

        // ---- 主题与外观 ----
        moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
        sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
        palette: '<circle cx="13.5" cy="6.5" r="1.4"/><circle cx="18" cy="11" r="1.4"/><circle cx="7.5" cy="8.5" r="1.4"/><circle cx="8" cy="15" r="1.4"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H18c2.8 0 5-2.2 5-5 0-5.5-4.9-10-11-10z"/>',
        sparkles: '<path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M18 15l.75 2.25L21 18l-2.25.75L18 21l-.75-2.25L15 18l2.25-.75z"/>',

        // ---- 功能与工具 ----
        cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
        broom: '<path d="M3 21l5-5"/><path d="M10 13l7-7 3 3-7 7-4 1z"/><path d="M8 15l-3 3"/>',
        puzzle: '<path d="M10 3a2 2 0 0 1 4 0v1h3a2 2 0 0 1 2 2v3h1a2 2 0 0 1 0 4h-1v3a2 2 0 0 1-2 2h-3v-1a2 2 0 0 0-4 0v1H7a2 2 0 0 1-2-2v-3H4a2 2 0 0 1 0-4h1V6a2 2 0 0 1 2-2h3z"/>',
        rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
        plug: '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
        bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A6 6 0 1 0 7.5 11.5c.76.76 1.23 1.52 1.41 2.5"/>',
        tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
        target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
        stack: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/>',
        gamepad: '<path d="M6 12h4"/><path d="M8 10v4"/><circle cx="15" cy="10" r="1"/><circle cx="18" cy="13" r="1"/><path d="M17.5 6H20a3 3 0 0 1 3 3v5a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V9a3 3 0 0 1 3-3h4.5"/>',
        factory: '<rect x="2" y="13" width="20" height="8"/><path d="M6 13V9l5 4V7l5 4V9l4 4"/>',

        // ---- 设备与介质 ----
        smartphone: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
        monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
        disc: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>',

        // ---- 文档与数据 ----
        scroll: '<path d="M5 3h14a2 2 0 0 1 2 2v12a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V5a2 2 0 0 1 2-2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/>',
        barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/><line x1="3" y1="21" x2="21" y2="21"/>',
        clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
        save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
        gitBranch: '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
        inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
        outbox: '<path d="M3 6h18v4H3z"/><path d="M5 10v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9"/><polyline points="9 14 12 11 15 14"/>',

        // ---- 状态 ----
        checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
        recycle: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
        gift: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
        heartBreak: '<path d="M8.5 3h7a5.5 5.5 0 0 1 5.5 5.5c0 2.5-1 4.5-3 6L12 20.5 6 14.5c-2-1.5-3-3.5-3-6A5.5 5.5 0 0 1 8.5 3z"/><path d="M11 5l-3.5 6.5L12 13l-2 4.5"/>',
        dot: '<circle cx="12" cy="12" r="5" fill="currentColor" stroke="none"/>',
        menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
        arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
        arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
        hamster: '<circle cx="12" cy="12" r="8"/><circle cx="9.2" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="14.8" cy="10" r="1" fill="currentColor" stroke="none"/><path d="M9 14.6a3.6 3.6 0 0 0 6 0"/>'
    };

    var Icons = {
        /** 所有图标名 */
        names: Object.keys(P),

        /**
         * 取一个图标的 SVG 字符串
         * @param {string} name 图标名
         * @param {Object} o { size, className, stroke, fill, style }
         */
        get: function (name, o) {
            var opt = o || {};
            var size = opt.size || 16;
            var body = P[name];
            if (!body) return '';   // 未知图标返回空，不报错
            var cls = 'ico' + (opt.className ? ' ' + opt.className : '');
            var style = opt.style ? ' style="' + opt.style + '"' : '';
            return '<svg class="' + cls + '" width="' + size + '" height="' + size +
                '" viewBox="0 0 24 24" fill="' + (opt.fill || 'none') +
                '" stroke="' + (opt.stroke || 'currentColor') +
                '" stroke-width="' + (opt.width || 2) +
                '" stroke-linecap="round" stroke-linejoin="round"' +
                ' aria-hidden="true" focusable="false"' + style + '>' + body + '</svg>';
        },

        /** 按文件名猜测图标（统一两应用的文件类型视觉） */
        forFile: function (name, o) {
            var n = String(name || '').toLowerCase();
            var ext = n.indexOf('.') > -1 ? n.split('.').pop() : '';
            var map = {
                // 文档
                md: 'fileText', txt: 'fileText', log: 'fileText',
                pdf: 'fileText', doc: 'fileText', docx: 'fileText',
                xls: 'fileText', xlsx: 'fileText', csv: 'fileText',
                ppt: 'fileText', pptx: 'fileText',
                // 代码
                js: 'fileCode', ts: 'fileCode', jsx: 'fileCode', tsx: 'fileCode',
                html: 'fileCode', css: 'fileCode', scss: 'fileCode',
                json: 'fileCode', xml: 'fileCode', yml: 'fileCode', yaml: 'fileCode',
                py: 'fileCode', go: 'fileCode', rs: 'fileCode', java: 'fileCode',
                c: 'fileCode', cpp: 'fileCode', h: 'fileCode', sh: 'fileCode',
                php: 'fileCode', rb: 'fileCode', vue: 'fileCode',
                // 图片
                png: 'fileImage', jpg: 'fileImage', jpeg: 'fileImage',
                gif: 'fileImage', svg: 'fileImage', webp: 'fileImage',
                bmp: 'fileImage', ico: 'fileImage',
                // 音频
                mp3: 'fileAudio', wav: 'fileAudio', flac: 'fileAudio',
                aac: 'fileAudio', ogg: 'fileAudio', m4a: 'fileAudio',
                // 视频
                mp4: 'fileVideo', avi: 'fileVideo', mov: 'fileVideo',
                mkv: 'fileVideo', webm: 'fileVideo', flv: 'fileVideo',
                // 压缩包
                zip: 'fileArchive', rar: 'fileArchive', '7z': 'fileArchive',
                tar: 'fileArchive', gz: 'fileArchive',
                // 可执行
                exe: 'package', dmg: 'package', apk: 'package', deb: 'package'
            };
            return this.get(map[ext] || 'file', o);
        },

        /**
         * 品牌图标（PNG，用于 favicon / 登录页 / 关于）
         * 路径相对各应用根目录
         */
        brand: function (app, size) {
            var s = size || 64;
            var f = app === 'drive' ? 'assets/icon-drive-192.png' : 'assets/icon-cangshu-192.png';
            return '<img class="brand-ico" src="' + f + '" width="' + s + '" height="' + s +
                '" alt="' + (app === 'drive' ? 'GitHub Drive' : '仓鼠') + '">';
        },

        /** 判断某名称是否有对应图标 */
        has: function (name) { return !!P[name]; },

        /**
         * emoji → 图标名
         *
         * ★ 为什么 key 要写两种（带/不带 U+FE0F）：
         *   同一个字符在不同编辑器里保存的形态不同 —— ⚙ 和 ⚙️ 是同一个图标，
         *   但 U+FE0F（变体选择符）可有可无。只登记一种会漏掉另一半。
         *   匹配时先查完整串、再查去掉 FE0F 的裸串，两种都能命中。
         *
         * ★ 国旗（🇬🇧🇪🇸…）刻意不登记：它们是语言标识，不是装饰图标，
         *   换成矢量图反而认不出是哪个国家。
         */
        EMOJI: {
            // 主题与外观
            '🌙': 'moon', '☀️': 'sun', '☀': 'sun', '🎨': 'palette', '✨': 'sparkles',
            // 功能
            '⚙️': 'settings', '⚙': 'settings', '🤖': 'cpu', '🧹': 'broom',
            '🧩': 'puzzle', '🚀': 'rocket', '🔌': 'plug', '💡': 'bulb',
            '🔧': 'tool', '🧰': 'tool', '🎯': 'target', '🗂️': 'stack', '🗂': 'stack',
            '🏭': 'factory', '🎮': 'gamepad', '🐍': 'code',
            // 设备与介质
            '💻': 'monitor', '📱': 'smartphone', '💿': 'disc',
            // 文件与文件夹
            '📁': 'folder', '📂': 'folderOpen', '📄': 'fileText', '📝': 'fileText',
            '📦': 'package', '🗜️': 'fileArchive', '🗜': 'fileArchive',
            '🖼️': 'image', '🎬': 'fileVideo', '🎵': 'fileAudio',
            '📘': 'book', '📗': 'book', '📙': 'book', '📕': 'book',
            '📜': 'scroll', '📋': 'clipboard', '📊': 'barChart',
            // 操作
            '⬆️': 'upload', '⬆': 'upload', '⬇️': 'download', '⬇': 'download',
            '📤': 'outbox', '📥': 'inbox', '🗑️': 'trash', '🗑': 'trash',
            '✏️': 'edit', '➕': 'plus', '🔍': 'search', '🔄': 'refresh',
            '🔗': 'link', '🏷️': 'tag', '🏷': 'tag', '⭐': 'star', '🌟': 'star',
            '💾': 'save', '🔀': 'gitBranch', '☰': 'menu',
            // 状态
            '⚠️': 'alert', '⚠': 'alert', '❓': 'help', '❌': 'xCircle',
            // ✕ U+2715：关闭按钮用的叉号。它在各系统上都是黑白线条、字形一致，
            //   严格说不算 emoji，但既然是图标用途，统一成矢量更整齐。
            '✕': 'x',
            '✅': 'checkCircle', '🔴': 'dot', '🟡': 'dot', '♻️': 'recycle',
            '🎉': 'gift', '💔': 'heartBreak', '⚡': 'zap',
            // 导航与人
            '🏠': 'home', '👤': 'user', '🚪': 'logout', '🌐': 'globe',
            '🕐': 'clock', '🐹': 'hamster'
        },

        /** 取某个 emoji 对应的图标名（没有则返回 null） */
        emojiToIcon: function (emoji) {
            if (!emoji) return null;
            var m = this.EMOJI;
            // 先查完整串（含 U+FE0F），再查剥掉 FE0F 的裸串
            return m[emoji] || m[emoji.replace(/\uFE0F/g, '')] || null;
        },

        /**
         * 把一棵子树里的 emoji 文本节点换成 SVG
         *
         * ★ 为什么要运行时扫，而不是把源码里的 emoji 全改掉：
         *   界面上一半文案是 JS 拼出来的（toast、弹窗标题、动态列表），
         *   源码改不完，以后新增还会漏。运行时扫一次兜底。
         *
         * ★ 只替换文本节点，不碰元素结构 —— 事件监听器绑在元素上，
         *   换掉文本节点不会把 onclick 弄丢。
         *
         * ★ 文本含 < > & 时不能用 innerHTML 拼，否则会解析成标签。
         *   这里用 createTextNode + 逐个 append 的方式组装，天然免疫注入。
         */
        scan: function (root) {
            root = root || document.body;
            if (!root) return 0;
            var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
            var todo = [];
            var n;
            while ((n = walker.nextNode())) {
                if (!n.nodeValue || n.nodeValue.length > 4000) continue;
                // ★ 必须每次显式归零 lastIndex。
                //   /g 正则的 test() 会把 lastIndex 推进到匹配结束处，
                //   下一次 test() 从那个位置接着找 —— 于是只有第一个含 emoji
                //   的节点被判定为"有"，后面的全部漏掉。
                //   实测：页面上「🐱 我的照片（文件名，应跳过）」先被 test 命中，
                //   lastIndex 停在它的匹配末尾，紧接着的「⚠️ 普通提示」就再也
                //   匹配不上了，表现是"有的换了有的没换"。
                //   用 .search() 也能绕开（它不看 lastIndex），但显式归零更直白。
                _EMOJI_RE.lastIndex = 0;
                if (!_EMOJI_RE.test(n.nodeValue)) continue;
                if (!_allowed(n)) continue;
                todo.push(n);
            }
            var changed = 0;
            for (var i = 0; i < todo.length; i++) {
                if (_replaceNode(todo[i])) changed++;
            }
            return changed;
        },

        /**
         * 挂上 MutationObserver，之后新增的 DOM 自动扫
         *
         * ★ 必须防重入：scan 自己会改 DOM，改完又触发 observer，
         *   不加 flag 就是"改→触发→再改→再触发"的空转。
         *   实际上第二次扫不到 emoji（已经换掉了）会自然停，
         *   但 debounce 期间连续触发会白白多跑几次遍历。
         */
        observe: function () {
            if (Icons._obs || typeof MutationObserver === 'undefined') return;
            var timer = null;
            Icons._obs = new MutationObserver(function () {
                if (Icons._scanning) return;
                clearTimeout(timer);
                timer = setTimeout(function () {
                    Icons._scanning = true;
                    try { Icons.scan(document.body); }
                    catch (e) { /* 扫描失败不能影响界面 */ }
                    Icons._scanning = false;
                }, 80);
            });
            Icons._obs.observe(document.body, {
                childList: true, subtree: true, characterData: true
            });
        }
    };

    // ---- 扫描用的内部实现 ----

    /**
     * 匹配"一个 emoji（可带若干变体选择符）"
     *
     * ★ 后面跟 \uFE0F? 而不是放字符类里：
     *   变体选择符必须紧跟在基础字符后面才有意义，
     *   写成字符类会匹配到孤立的 FE0F（前面那个"️ x13"就是这么来的）。
     */
    var _EMOJI_SRC =
        '(?:[\u2600-\u27BF\u2B00-\u2BFF]' +      // 符号/杂项（⚙ ⚠ ☀ ⭐ ⬆ ⬇ …）
        '|\uD83C[\uDF00-\uDFFF]' +                // 代理对：🌀-🿿
        '|\uD83D[\uDC00-\uDE4F\uDE80-\uDEFF]' +   // 代理对：😀-🙏、🚀-🛿
        '|\uD83E[\uDD00-\uDDFF])' +               // 代理对：🤐-🩿
        '\uFE0F?';                                // 变体选择符（可有可无）
    var _EMOJI_RE = new RegExp(_EMOJI_SRC, 'g');

    /**
     * 判断这个文本节点能不能动
     *
     * ★ 必须保护的：
     *   · 文件名 / 路径 —— 用户自己的文件可能就叫 "🐱 照片"，
     *     把里面的 emoji 换成图标等于篡改了用户数据
     *   · script / style / code / pre —— 代码里的字符不能动
     *   · 输入框相关 —— value 不由文本节点承载，但 label、option 要小心
     *   · [data-no-emoji] —— 给需要保留 emoji 的地方留的逃生口
     */
    var _SKIP_SEL = 'script,style,code,pre,textarea,[contenteditable="true"],' +
        '[data-no-emoji],.gd-no-emoji,.file-name,.file-item-name,.breadcrumb';

    function _allowed(node) {
        var p = node.parentElement;
        if (!p) return false;
        // closest 从自己开始查，正好覆盖"节点就在 .file-name 里"的情况
        try {
            if (p.closest && p.closest(_SKIP_SEL)) return false;
        } catch (e) { /* 选择器异常时保守放行 */ }
        return true;
    }

    /** 把一个含 emoji 的文本节点拆成 [文本, SVG, 文本, ...] */
    function _replaceNode(node) {
        var s = node.nodeValue;
        _EMOJI_RE.lastIndex = 0;
        var frag = document.createDocumentFragment();
        var last = 0, m, hit = 0;
        while ((m = _EMOJI_RE.exec(s))) {
            var name = Icons.emojiToIcon(m[0]);
            if (!name) continue;
            if (m.index > last) {
                frag.appendChild(document.createTextNode(s.slice(last, m.index)));
            }
            var holder = document.createElement('span');
            holder.innerHTML = Icons.get(name, { className: 'gd-emoji-ico' });
            while (holder.firstChild) frag.appendChild(holder.firstChild);
            last = m.index + m[0].length;
            hit++;
        }
        if (!hit) return false;
        if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
        node.parentNode.replaceChild(frag, node);
        return true;
    }

    if (typeof module !== 'undefined' && module.exports) module.exports = Icons;
    else global.Icons = Icons;

    // ---- 自动接管 ----
    //
    // ★ 为什么这里就自启动，不等 app.js：
    //   顶栏、侧边栏的 emoji 写在 index.html 里，是静态文本节点。
    //   icons.js 是 CORE 第一个，等 defer 全部跑完再扫就晚了一拍，
    //   首屏会先闪一下 emoji 再变图标。
    //
    // ★ scan 只处理此刻已经在 DOM 里的；之后 ui/app 动态渲染出来的
    //   （toast、弹窗、文件列表）由 observe() 的 MutationObserver 兜住。
    if (typeof document !== 'undefined' && typeof global.Icons !== 'undefined') {
        var _boot = function () {
            try {
                Icons.scan(document.body);
                Icons.observe();
            } catch (e) { /* 图标替换失败不能影响页面可用 */ }
        };
        // defer 脚本执行时通常已是 interactive，但分支判断留着更稳
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', _boot);
        } else {
            _boot();
        }
    }
})(typeof window !== 'undefined' ? window : globalThis);
