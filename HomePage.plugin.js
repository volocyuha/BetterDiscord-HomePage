/**
 * @name Home Page
 * @author volocyuha
 * @authorLink https://github.com/volocyuha?tab=repositories
 * @version 1.0.1
 * @description Adds a native-style Home dashboard for browsing servers, folders, favorites, unread activity and server information.
 * @website https://volocyuha.com/
 * @source https://github.com/volocyuha?tab=repositories
 * @donate https://paypal.me/volocyuha
 */

module.exports = class ServerDashboard {
    constructor() {
        this.defaults = {
            showHomeButton: true, showRecentServers: true,
            recentServersMode: "auto", maxRecentServers: 8, showFolders: true, showDescriptions: true,
            showMemberCounts: true, showVoiceActivity: true, showUnreadIndicators: true, showMentionIndicators: true,
            showFavorites: true, showFavoritesByDefault: true, favoriteGuildIds: [], recentGuildIds: [], recentHistoryInitialized: false,
            defaultSort: "discord", defaultFilter: "all",
            dashboardWidth: "calc(100vw - 80px)", dashboardHeight: "calc(100vh - 32px)", debug: false
        };
        this.cssKey = "ServerDashboardStyles";
        this.open = false;
        this.query = "";
        this.filter = "all";
        this.sort = "discord";
        this.expandedFolders = new Set();
        this.unsubscribers = [];
        this.frame = 0;
        this.observer = null;
    }

    start() {
        this.stopped = false;
        this.previewCache = this.loadDescriptionCache();
        this.previewQueue = [];
        this.previewQueued = new Set();
        this.previewActive = 0;
        this.previewRefreshing = false;
        this.previewRefreshAnimating = false;
        this.previewErrorShown = false;
        this.loadSettings();
        this.filter = this.settings.defaultFilter;
        this.sort = this.settings.defaultSort;
        this.homeSection = this.settings.showFavorites && this.settings.showFavoritesByDefault ? "favorites" : "recent";
        this.findStores();
        BdApi.DOM.addStyle(this.cssKey, this.styles());
        this.createDashboard();
        this.createHomeButton();
        this.createNativeSidebarHome();
        this.onKeyDown = e => { if (e.key === "Escape" && this.open) this.closeDashboard(); };
        this.onResize = () => this.scheduleRender();
        this.onNativeNavigation = e => {
            if (!this.open || this.dashboard?.contains(e.target) || this.nativeSidebarHome?.contains(e.target)) return;
            if (e.clientX >= this.dashboard.getBoundingClientRect().left) return;
            const path = e.composedPath?.() || [];
            const directMessage = path.find(node => {
                if (!(node instanceof Element)) return false;
                const href = node.getAttribute?.("href") || "";
                const itemId = node.getAttribute?.("data-list-item-id") || "";
                return /^\/channels\/@me\/[^/]+/.test(href) || /private[-_ ]channels?.*(?:___|-)[^_-]+$/i.test(itemId);
            });
            if (directMessage) {
                clearTimeout(this.directMessagesTimer);
                this.directMessagesTimer = null;
                this.closeDashboard(false);
                return;
            }
            setTimeout(() => {
                if (!this.open) return;
                let selectedGuild = null;
                try { selectedGuild = this.SelectedGuildStore?.getGuildId?.() || null; } catch (_) {}
                if (selectedGuild !== this.dashboardBaseGuildId || location.pathname !== this.dashboardBasePath) this.closeDashboard();
            }, 50);
        };
        document.addEventListener("keydown", this.onKeyDown);
        document.addEventListener("click", this.onNativeNavigation, true);
        window.addEventListener("resize", this.onResize);
        this.subscribeStores();
        this.observer = new MutationObserver(() => {
            this.handleExternalNavigation();
            if (this.settings.showHomeButton && !this.onHomeClick) this.createHomeButton();
            else if (this.settings.showHomeButton && (!this.homeButton || !document.body.contains(this.homeButton))) this.refreshHomeButtonReference();
            if (this.settings.showHomeButton && (!this.nativeSidebarHome || !document.body.contains(this.nativeSidebarHome))) this.createNativeSidebarHome();
        });
        this.observer.observe(document.body, {childList: true, subtree: true});
        this.recordRecentGuild(this.SelectedGuildStore?.getGuildId?.(), false);
    }

    stop() {
        this.stopped = true;
        this.previewQueue = [];
        document.removeEventListener("keydown", this.onKeyDown);
        document.removeEventListener("click", this.onNativeNavigation, true);
        window.removeEventListener("resize", this.onResize);
        this.observer?.disconnect();
        clearTimeout(this.directMessagesTimer);
        clearTimeout(this.previewPumpTimer);
        clearTimeout(this.guildOpenTimer);
        clearTimeout(this.descriptionCacheTimer);
        clearTimeout(this.previewAnimationTimer);
        clearTimeout(this.activityRenderTimer);
        clearTimeout(this.interactionRenderTimer);
        this.saveDescriptionCache();
        this.unsubscribers.splice(0).forEach(fn => { try { fn(); } catch (_) {} });
        cancelAnimationFrame(this.frame);
        this.updateNativeSidebarSelection(false);
        this.dashboard?.remove();
        this.nativeSidebarHome?.remove();
        this.detachHomeButton();
        BdApi.DOM.removeStyle(this.cssKey);
        this.dashboard = this.homeButton = this.observer = null;
        this.nativeSidebarHome = null;
        this.nativeSidebarHomeControl = null;
    }

    loadSettings() {
        const saved = BdApi.Data.load("ServerDashboard", "settings") || {};
        this.settings = Object.assign({}, this.defaults, saved);
        if (!Object.prototype.hasOwnProperty.call(saved, "showUnreadIndicators")) this.settings.showUnreadIndicators = saved.showUnreadSummary ?? true;
        if (!Object.prototype.hasOwnProperty.call(saved, "showMentionIndicators")) this.settings.showMentionIndicators = saved.showUnreadSummary ?? true;
        for (const key of ["favoriteGuildIds", "recentGuildIds"]) {
            if (!Array.isArray(this.settings[key])) this.settings[key] = [];
        }
        if (!['auto', 'fixed'].includes(this.settings.recentServersMode)) this.settings.recentServersMode = "auto";
        this.settings.maxRecentServers = Math.max(1, Math.min(50, Number(this.settings.maxRecentServers) || 8));
    }

    saveSettings() { BdApi.Data.save("ServerDashboard", "settings", this.settings); }

    loadDescriptionCache() {
        const saved = BdApi.Data.load("ServerDashboard", "guildDescriptions") || {};
        const now = Date.now(), maxAge = 30 * 24 * 60 * 60 * 1000;
        return new Map(Object.entries(saved).filter(([, value]) => typeof value?.description === "string" && value.description && now - Number(value.savedAt || 0) < maxAge).map(([id, value]) => [id, {description:value.description, online:0, members:0, fresh:false}]));
    }

    scheduleDescriptionCacheSave() {
        clearTimeout(this.descriptionCacheTimer);
        this.descriptionCacheTimer = setTimeout(() => this.saveDescriptionCache(), 1000);
    }

    saveDescriptionCache() {
        if (!this.previewCache) return;
        const savedAt = Date.now(), data = {};
        for (const [id, value] of this.previewCache) if (value?.description) data[id] = {description:value.description, savedAt};
        BdApi.Data.save("ServerDashboard", "guildDescriptions", data);
    }
    log(...args) { if (this.settings.debug) console.debug("[ServerDashboard]", ...args); }

    findStores() {
        const get = name => { try { return BdApi.Webpack.getStore(name); } catch (_) { return null; } };
        this.GuildStore = get("GuildStore");
        this.SortedGuildStore = get("SortedGuildStore");
        this.FolderStore = get("ExpandedGuildFolderStore");
        this.ReadStore = get("GuildReadStateStore");
        this.SelectedGuildStore = get("SelectedGuildStore");
        this.SelectedChannelStore = get("SelectedChannelStore");
        this.UserStore = get("UserStore");
        this.ChannelStore = get("ChannelStore");
        this.GuildChannelStore = get("GuildChannelStore") || get("GuildChannelsStore");
        this.DefaultChannelStore = get("DefaultChannelStore");
        this.GuildProfileStore = get("GuildProfileStore");
        this.StageInstanceStore = get("StageInstanceStore");
        this.ScheduledEventStore = get("GuildScheduledEventStore") || get("GuildScheduledEventsStore");
        this.AuthenticationStore = get("AuthenticationStore") || get("AuthStore");
        const find = predicate => { try { return BdApi.Webpack.getModule(predicate, {searchExports:true}); } catch (_) { return null; } };
        this.AuthenticationStore ||= find(m => typeof m?.getToken === "function" && (typeof m?.isAuthenticated === "function" || typeof m?.getId === "function"));
        this.GuildPreviewStore = get("GuildPreviewStore") || find(m => typeof m?.getGuildPreview === "function");
        this.PreviewActions = find(m => typeof m?.fetchGuildPreview === "function" || typeof m?.requestGuildPreview === "function");
        this.ProfileActions = find(m => typeof m?.fetchGuildProfile === "function" || typeof m?.requestGuildProfile === "function");
        this.PresenceStore ||= find(m => typeof m?.getGuildPresenceCount === "function");
        this.MemberCountStore = get("GuildMemberCountStore");
        this.PresenceStore = get("GuildPresenceStore") || get("PresenceStore");
        this.SortedVoiceStore = get("SortedVoiceStateStore");
        this.VoiceStateStore = get("VoiceStateStore");
        this.VoiceMemberStore = get("VoiceChannelMemberStore") || get("VoiceChannelMembersStore");
        this.ChannelMemberStore = get("ChannelMemberStore") || get("ChannelMembersStore");
        this.VoiceStore = this.SortedVoiceStore || this.VoiceStateStore;
        this.VoiceStateStore ||= find(m => typeof m?.getVoiceStatesForGuild === "function" || typeof m?.getVoiceStatesForChannel === "function" || typeof m?.getAllVoiceStates === "function");
        this.StageInstanceStore ||= find(m => typeof m?.getStageInstanceByChannel === "function" || typeof m?.getStageInstancesForGuild === "function" || typeof m?.getStageInstanceByGuild === "function");
        this.VoiceStore = this.SortedVoiceStore || this.VoiceStateStore;
        try {
            this.Navigation = BdApi.Webpack.getByKeys?.("transitionTo", "replaceWith", "getHistory") || BdApi.Webpack.getByKeys?.("transitionTo", "replaceWith") || BdApi.Webpack.getModule(m => m?.transitionToGuild || m?.transitionTo, {searchExports: true});
        } catch (_) { this.Navigation = null; }
        try {
            this.Dispatcher = BdApi.Webpack.getByKeys?.("dispatch", "subscribe", "unsubscribe") || find(m => typeof m?.dispatch === "function" && typeof m?.subscribe === "function" && typeof m?.unsubscribe === "function");
        } catch (_) { this.Dispatcher = null; }
        this.History = find(m => typeof m?.push === "function" && typeof m?.replace === "function" && typeof m?.listen === "function");
        try {
            this.HTTP = BdApi.Webpack.getModule(m => typeof m?.get === "function" && typeof m?.post === "function" && (typeof m?.patch === "function" || typeof m?.put === "function"), {searchExports: true});
        } catch (_) { this.HTTP = null; }
    }

    subscribeStores() {
        const activityStores = new Set([this.VoiceStateStore, this.SortedVoiceStore, this.StageInstanceStore, this.ScheduledEventStore].filter(Boolean));
        const stores = [this.GuildStore, this.SortedGuildStore, this.ReadStore, this.SelectedGuildStore, this.SelectedChannelStore, ...activityStores].filter((store, index, list) => store && list.indexOf(store) === index);
        for (const store of stores) {
            if (!store?.addChangeListener || !store?.removeChangeListener) continue;
            const cb = () => {
                if (store === this.SelectedGuildStore) this.recordRecentGuild(store.getGuildId?.());
                if (store === this.SelectedChannelStore) {
                    const channelId = store.getChannelId?.() || store.getCurrentlySelectedChannelId?.() || null;
                    if (this.open && channelId !== this.dashboardBaseChannelId) {
                        this.closeDashboard(false);
                        return;
                    }
                }
                if (activityStores.has(store)) {
                    clearTimeout(this.activityRenderTimer);
                    this.activityRenderTimer = setTimeout(() => this.scheduleRender(), 750);
                }
                else this.scheduleRender();
            };
            store.addChangeListener(cb);
            this.unsubscribers.push(() => store.removeChangeListener(cb));
        }
        if (this.History?.listen) {
            try {
                const unlisten = this.History.listen(() => this.handleExternalNavigation(true));
                if (typeof unlisten === "function") this.unsubscribers.push(unlisten);
            } catch (error) { this.log("Could not subscribe to Discord history", error); }
        }
        if (this.Dispatcher?.subscribe && this.Dispatcher?.unsubscribe) {
            const onChannelSelect = () => { if (this.open) this.closeDashboard(false); };
            try {
                this.Dispatcher.subscribe("CHANNEL_SELECT", onChannelSelect);
                this.unsubscribers.push(() => this.Dispatcher.unsubscribe("CHANNEL_SELECT", onChannelSelect));
            } catch (error) { this.log("Could not subscribe to channel navigation", error); }
        }
        this.onPopState = () => this.handleExternalNavigation(true);
        window.addEventListener("popstate", this.onPopState);
        this.unsubscribers.push(() => window.removeEventListener("popstate", this.onPopState));
        this.routeMonitorTimer = setInterval(() => this.handleExternalNavigation(), 100);
        this.unsubscribers.push(() => clearInterval(this.routeMonitorTimer));
    }

    handleExternalNavigation(force = false) {
        if (this.stopped || !this.open || !this.dashboardBasePath) return;
        const path = location.pathname;
        if (force || (path !== this.dashboardBasePath && path.startsWith("/channels/"))) this.closeDashboard(false);
    }

    scheduleRender() {
        if (!this.open || this.frame) return;
        const interactionDelay = (this.interactionUntil || 0) - Date.now();
        if (interactionDelay > 0) {
            clearTimeout(this.interactionRenderTimer);
            this.interactionRenderTimer = setTimeout(() => this.scheduleRender(), interactionDelay + 20);
            return;
        }
        this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderDashboard(); });
    }

    createDashboard() {
        this.dashboard = document.createElement("div");
        this.dashboard.className = "sd-dashboard";
        this.dashboard.setAttribute("role", "dialog");
        this.dashboard.setAttribute("aria-modal", "true");
        this.dashboard.setAttribute("aria-label", "Server Dashboard");
        this.dashboard.hidden = true;
        this.dashboard.innerHTML = `<header class="sd-titlebar"><div></div><div class="sd-titlebar-name"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z"/></svg><strong>Dashboard</strong></div><div class="sd-title-actions"><button data-action="inbox" aria-label="Inbox"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 3H5a2 2 0 0 0-2 2v14h18V5a2 2 0 0 0-2-2Zm0 11h-4l-1.5 2h-3L9 14H5V5h14v9Z"/></svg></button><button data-action="help" aria-label="Help"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm.1 16.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Zm2.15-7.15c-.9.65-1.25 1.05-1.25 2.15h-2c0-1.85.75-2.65 1.9-3.45.75-.55 1.1-.9 1.1-1.55 0-.9-.7-1.5-1.8-1.5-1.05 0-1.8.55-2.4 1.45L8.2 7.3A4.7 4.7 0 0 1 12.3 5c2.3 0 3.8 1.35 3.8 3.35 0 1.4-.7 2.2-1.85 3Z"/></svg></button><span class="sd-title-separator"></span><div class="sd-window-actions"><button data-window="minimize" aria-label="Minimize"><span class="sd-minimize"></span></button><button data-window="maximize" aria-label="Maximize"><span class="sd-maximize"></span></button><button data-window="close" aria-label="Close"><span class="sd-window-close">×</span></button></div></div></header><main class="sd-shell"><div class="sd-content"></div></main>`;
        this.dashboard.addEventListener("click", e => this.handleClick(e));
        this.dashboard.addEventListener("pointerdown", () => { this.interactionUntil = Date.now() + 350; });
        this.dashboard.addEventListener("keydown", e => this.handleKey(e));
        this.dashboard.addEventListener("dragstart", e => this.handleDragStart(e));
        this.dashboard.addEventListener("dragover", e => this.handleDragOver(e));
        this.dashboard.addEventListener("dragleave", e => this.handleDragLeave(e));
        this.dashboard.addEventListener("drop", e => this.handleDrop(e));
        this.dashboard.addEventListener("dragend", () => this.finishDrag());
        document.body.appendChild(this.dashboard);
    }

    createHomeButton() {
        this.detachHomeButton();
        if (!this.settings.showHomeButton) return;
        this.onHomeClick = e => {
            const path = e.composedPath?.() || [];
            const guildNav = path.find(node => node instanceof Element && node.matches?.('[data-list-id="guildsnav"]'));
            if (!guildNav) return;
            const homeItem = path.find(node => {
                if (!(node instanceof Element)) return false;
                const href = node.getAttribute?.("href") || "";
                const itemId = node.getAttribute?.("data-list-item-id") || "";
                return href === "/channels/@me" || href.endsWith("/channels/@me") || /guildsnav.*home/i.test(itemId);
            });
            if (!homeItem) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            this.openDashboardFromDiscordHome();
        };
        document.addEventListener("click", this.onHomeClick, true);
        this.refreshHomeButtonReference();
    }

    refreshHomeButtonReference() {
        const button = document.querySelector('[data-list-id="guildsnav"] [data-list-item-id*="home" i], [data-list-id="guildsnav"] a[href$="/channels/@me"], [data-list-id="guildsnav"] [aria-label*="Direct Messages" i]');
        if (!button || button === this.homeButton) return;
        if (this.homeButton) {
            this.homeButton.classList.remove("sd-native-home", "sd-native-home-active");
            if (this.homeButtonTitle === null) this.homeButton.removeAttribute("title");
            else if (this.homeButtonTitle !== undefined) this.homeButton.setAttribute("title", this.homeButtonTitle);
        }
        this.homeButton = button;
        this.homeButtonTitle = button.getAttribute("title");
        button.classList.add("sd-native-home");
        button.setAttribute("title", "Home Page");
    }

    createNativeSidebarHome() {
        if (this.open) this.updateNativeSidebarSelection(false);
        this.nativeSidebarHome?.remove();
        this.nativeSidebarHome = null;
        this.nativeSidebarHomeControl = null;
        if (!this.settings.showHomeButton) return;
        const candidates = [...document.querySelectorAll('a,button,[role="link"],[role="button"],[data-list-item-id]')];
        const friends = candidates.find(node => {
            if (this.dashboard?.contains(node) || node.textContent.trim() !== "Friends") return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 120 && rect.left >= 60 && rect.left < 280 && rect.top > 30;
        });
        if (!friends?.parentElement) return;
        const target = friends.closest("li") || friends;
        const neutral = candidates.find(node => {
            if (this.dashboard?.contains(node) || node.textContent.trim() !== "Message Requests") return false;
            const rect = node.getBoundingClientRect();
            return rect.width > 120 && rect.left >= 60 && rect.left < 280 && rect.top > 30;
        });
        const source = neutral?.closest("li") || neutral || target;
        const sourceLabel = neutral ? "Message Requests" : "Friends";
        const home = source.cloneNode(true);
        home.classList.add("sd-native-sidebar-home-clone");
        for (const node of [home, ...home.querySelectorAll("*")]) {
            node.removeAttribute?.("id");
            node.removeAttribute?.("href");
            node.removeAttribute?.("aria-current");
            node.removeAttribute?.("aria-selected");
            node.removeAttribute?.("aria-label");
            node.removeAttribute?.("data-list-item-id");
        }
        const walker = document.createTreeWalker(home, NodeFilter.SHOW_TEXT);
        let textNode;
        while ((textNode = walker.nextNode())) {
            if (textNode.nodeValue.trim() === sourceLabel) textNode.nodeValue = textNode.nodeValue.replace(sourceLabel, "Home");
        }
        const icon = home.querySelector("svg");
        if (icon) {
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.innerHTML = `<path fill="currentColor" d="M4 12 12 5l8 7v8a2 2 0 0 1-2 2h-4v-6h-4v6H6a2 2 0 0 1-2-2v-8Z"/>`;
        }
        home.setAttribute("aria-label", "Home");
        home.addEventListener("click", e => {
            e.preventDefault();
            e.stopPropagation();
            this.openDashboard();
        }, true);
        target.parentElement.insertBefore(home, target);
        this.nativeSidebarHome = home;
        this.nativeSidebarHomeControl = home.matches('a,button,[role="link"],[role="button"],[data-list-item-id]') ? home : home.querySelector('a,button,[role="link"],[role="button"],[data-list-item-id]') || home;
        if (this.open) this.updateNativeSidebarSelection(true);
    }

    detachHomeButton() {
        if (this.onHomeClick) document.removeEventListener("click", this.onHomeClick, true);
        if (this.homeButton) {
            this.homeButton.classList.remove("sd-native-home", "sd-native-home-active");
            if (this.homeButtonTitle === null) this.homeButton.removeAttribute("title");
            else if (this.homeButtonTitle !== undefined) this.homeButton.setAttribute("title", this.homeButtonTitle);
        }
        this.homeButton = null;
        this.onHomeClick = null;
        this.homeButtonTitle = null;
    }

    openDashboardFromDiscordHome() {
        clearTimeout(this.directMessagesTimer);
        const nativeHome = this.homeButton;
        if (nativeHome && this.onHomeClick) {
            document.removeEventListener("click", this.onHomeClick, true);
            try { nativeHome.click(); } catch (_) {}
            document.addEventListener("click", this.onHomeClick, true);
        } else {
            try {
                if (!this.navigateSpa("/channels/@me")) { BdApi.UI.showToast("Could not open Direct Messages.", {type:"error"}); return; }
            } catch (_) { BdApi.UI.showToast("Could not open Direct Messages.", {type:"error"}); return; }
        }
        this.waitForDirectMessagesSidebar(0);
    }

    waitForDirectMessagesSidebar(attempt) {
        const friends = [...document.querySelectorAll('a,button,[role="link"],[role="button"],[data-list-item-id]')].find(node => {
            if (this.dashboard?.contains(node) || node.textContent.trim() !== "Friends") return false;
            const rect = node.getBoundingClientRect();
            return rect.left >= 60 && rect.left < 280 && rect.top > 30;
        });
        if (friends) {
            this.createNativeSidebarHome();
            this.openDashboard();
            return;
        }
        if (attempt >= 40) {
            BdApi.UI.showToast("Could not open the Direct Messages sidebar.", {type:"error"});
            return;
        }
        this.directMessagesTimer = setTimeout(() => this.waitForDirectMessagesSidebar(attempt + 1), 50);
    }

    openDashboard() {
        if (!this.dashboard) return;
        this.homeSection = this.settings.showFavorites && this.settings.showFavoritesByDefault ? "favorites" : "recent";
        try { this.dashboardBaseGuildId = this.SelectedGuildStore?.getGuildId?.() || null; } catch (_) { this.dashboardBaseGuildId = null; }
        try { this.dashboardBaseChannelId = this.SelectedChannelStore?.getChannelId?.() || this.SelectedChannelStore?.getCurrentlySelectedChannelId?.() || null; } catch (_) { this.dashboardBaseChannelId = null; }
        this.dashboardBasePath = location.pathname;
        this.captureNativeAppearance();
        this.positionAfterNativeSidebar();
        this.open = true;
        this.dashboard.hidden = false;
        this.dashboard.classList.add("sd-open");
        this.homeButton?.classList.add("sd-native-home-active");
        this.updateNativeSidebarSelection(true);
        this.renderDashboard();
        requestAnimationFrame(() => this.dashboard.querySelector(".sd-search")?.focus());
    }

    closeDashboard(restoreFocus = true) {
        if (!this.dashboard) return;
        clearTimeout(this.directMessagesTimer);
        this.directMessagesTimer = null;
        this.open = false;
        this.dashboard.classList.remove("sd-open");
        this.dashboard.hidden = true;
        this.homeButton?.classList.remove("sd-native-home-active");
        this.updateNativeSidebarSelection(false);
        if (restoreFocus) this.homeButton?.focus();
    }

    toggleDashboard() { this.open ? this.closeDashboard() : this.openDashboard(); }

    updateNativeSidebarSelection(selected) {
        this.nativeSidebarHomeControl?.classList.toggle("sd-dashboard-selected", selected);
        if (!selected) {
            for (const node of this.suppressedNativeSelections || []) node.classList.remove("sd-native-selection-suppressed");
            this.suppressedNativeSelections = [];
            return;
        }
        for (const node of this.suppressedNativeSelections || []) node.classList.remove("sd-native-selection-suppressed");
        this.suppressedNativeSelections = [];
        const labels = new Set(["Friends", "Message Requests", "Nitro", "Shop", "Quests"]);
        const controls = [...document.querySelectorAll('a,button,[role="link"],[role="button"],[data-list-item-id]')].filter(node => {
            if (this.dashboard.contains(node) || this.nativeSidebarHome?.contains(node)) return false;
            const rect = node.getBoundingClientRect();
            return rect.left >= 60 && rect.left < 280 && labels.has(node.textContent.trim().replace(/\s+/g, " "));
        });
        const surfaces = new Set();
        for (const control of controls) {
            let node = control;
            for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
                const rect = node.getBoundingClientRect();
                if (rect.left >= 60 && rect.left < 280 && rect.width > 120 && rect.height >= 30 && rect.height <= 50) surfaces.add(node);
            }
        }
        for (const surface of surfaces) {
            surface.classList.add("sd-native-selection-suppressed");
            this.suppressedNativeSelections.push(surface);
        }
    }

    positionAfterNativeSidebar() {
        const friends = [...document.querySelectorAll('a,button,[role="link"],[role="button"],[data-list-item-id]')].find(node => {
            if (this.dashboard.contains(node) || node.textContent.trim() !== "Friends") return false;
            const rect = node.getBoundingClientRect();
            return rect.left >= 60 && rect.left < 280 && rect.top > 30;
        });
        let node = friends, sidebar = null;
        while (node && node !== document.body) {
            const rect = node.getBoundingClientRect();
            if (rect.left >= 60 && rect.left < 100 && rect.width >= 160 && rect.width <= 280 && rect.height > innerHeight * .65) sidebar = node;
            node = node.parentElement;
        }
        const friendsRight = friends?.getBoundingClientRect?.().right;
        const right = sidebar?.getBoundingClientRect?.().right || (friendsRight ? friendsRight + 8 : 260);
        this.dashboard.style.left = `${Math.round(right > 200 && right < 380 ? right : 260)}px`;
    }

    captureNativeAppearance() {
        const nativeElementAt = (x, y) => {
            const nodes = document.elementsFromPoint(x, y);
            return nodes.find(node => node instanceof HTMLElement && !this.dashboard?.contains(node)) || null;
        };
        const backgroundAt = (x, y) => {
            let node = nativeElementAt(x, y);
            while (node && node !== document.documentElement) {
                const color = getComputedStyle(node).backgroundColor;
                const alpha = color?.match(/^rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/)?.[1];
                if (color && color !== "transparent" && color !== "rgba(0, 0, 0, 0)" && (alpha === undefined || Number(alpha) > 0.25)) return color;
                node = node.parentElement;
            }
            return "";
        };
        const sidebar = backgroundAt(Math.min(170, innerWidth * .15), Math.max(180, innerHeight * .45));
        const content = backgroundAt(Math.max(360, innerWidth * .58), Math.max(180, innerHeight * .45));
        if (sidebar) this.dashboard.style.setProperty("--sd-native-sidebar-bg", sidebar);
        if (content) this.dashboard.style.setProperty("--sd-native-content-bg", content);

        const parseRgb = value => value?.match(/[\d.]+/g)?.slice(0, 3).map(Number);
        const rgb = parseRgb(content);
        const sidebarRgb = parseRgb(sidebar);
        const getLuminance = channels => channels?.length === 3 ? channels.map(value => {
                const channel = value / 255;
                return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
            }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0) : 0;
        if (rgb?.length === 3) {
            const light = Math.max(getLuminance(rgb), getLuminance(sidebarRgb)) > .42;
            const average = rgb.reduce((sum, value) => sum + value, 0) / 3;
            const ash = !light && Math.max(average, sidebarRgb?.reduce((sum, value) => sum + value, 0) / 3 || 0) >= 38;
            const mix = (target, amount) => `rgb(${rgb.map(value => Math.round(value + (target - value) * amount)).join(" ")})`;
            const palette = light ? {
                surface: "rgb(255 255 255)", card: "rgb(242 243 245)", hover: "rgb(227 229 232)", control: "rgb(235 237 239)"
            } : ash ? {
                surface: content, card: mix(0, .10), hover: mix(0, .17), control: mix(0, .14)
            } : {
                surface: content, card: mix(255, average < 16 ? .075 : .06), hover: mix(255, average < 16 ? .12 : .10), control: mix(255, .08)
            };
            this.dashboard.dataset.sdPalette = light ? "light" : ash ? "ash" : average < 16 ? "midnight" : "dark";
            this.dashboard.style.setProperty("--sd-surface", palette.surface);
            this.dashboard.style.setProperty("--sd-card-surface", palette.card);
            this.dashboard.style.setProperty("--sd-card-hover", palette.hover);
            this.dashboard.style.setProperty("--sd-control-surface", palette.control);
            this.dashboard.style.setProperty("--sd-strong-text", light ? "#1e1f22" : "#f2f3f5");
            this.dashboard.style.setProperty("--sd-normal-text", light ? "#313338" : "#dbdee1");
            this.dashboard.style.setProperty("--sd-muted-text", light ? "#5c5e66" : "#b5bac1");
            this.dashboard.style.setProperty("--sd-card-border", light ? "rgba(6, 6, 7, .14)" : "rgba(255, 255, 255, .10)");
            this.dashboard.style.setProperty("--sd-card-border-hover", light ? "rgba(6, 6, 7, .24)" : "rgba(255, 255, 255, .20)");
        }

        // Discord scopes its theme tokens to the app tree. The dashboard is mounted
        // under body, so explicitly inherit the resolved native tokens from the
        // content surface instead of falling back to dark-only colors.
        const source = nativeElementAt(Math.max(360, innerWidth * .58), Math.max(180, innerHeight * .45))
            || nativeElementAt(Math.min(170, innerWidth * .15), Math.max(180, innerHeight * .45));
        if (!source) return;
        const themeClasses = new Set();
        for (let node = source; node; node = node.parentElement) {
            for (const name of node.classList || []) if (name.startsWith("theme-")) themeClasses.add(name);
        }
        for (const node of [document.documentElement, document.body, document.querySelector('[class*="theme-"]')]) {
            for (const name of node?.classList || []) if (name.startsWith("theme-")) themeClasses.add(name);
        }
        for (const name of [...this.dashboard.classList]) if (name.startsWith("theme-")) this.dashboard.classList.remove(name);
        for (const name of themeClasses) this.dashboard.classList.add(name);

        const setPalette = (name, surface, card, hover, control, light = false) => {
            this.dashboard.dataset.sdPalette = name;
            this.dashboard.style.setProperty("--sd-surface", surface);
            this.dashboard.style.setProperty("--sd-card-surface", card);
            this.dashboard.style.setProperty("--sd-card-hover", hover);
            this.dashboard.style.setProperty("--sd-control-surface", control);
            this.dashboard.style.setProperty("--sd-strong-text", light ? "#1e1f22" : "#f2f3f5");
            this.dashboard.style.setProperty("--sd-normal-text", light ? "#313338" : "#dbdee1");
            this.dashboard.style.setProperty("--sd-muted-text", light ? "#5c5e66" : "#b5bac1");
            this.dashboard.style.setProperty("--sd-card-border", light ? "rgba(6, 6, 7, .14)" : "rgba(255, 255, 255, .10)");
            this.dashboard.style.setProperty("--sd-card-border-hover", light ? "rgba(6, 6, 7, .24)" : "rgba(255, 255, 255, .20)");
        };
        if (themeClasses.has("theme-light")) {
            setPalette("light", "#ffffff", "#f2f3f5", "#e3e5e8", "#ebedef", true);
            this.dashboard.style.setProperty("--sd-native-content-bg", "#ffffff");
        } else if (themeClasses.has("theme-midnight")) {
            setPalette("midnight", content || "#000000", "#111214", "#1a1b1e", "#17181c");
        } else if (themeClasses.has("theme-darker")) {
            setPalette("dark", content || "#1a1a1e", "#202225", "#292b2f", "#232428");
        } else if (themeClasses.has("theme-dark")) {
            setPalette("ash", content || "#313338", "#2b2d31", "#35373c", "#25262a");
        }

        const nativeStyle = getComputedStyle(source);
        const themeTokens = [
            "--font-primary", "--font-display", "--font-code",
            "--background-primary", "--background-secondary", "--background-secondary-alt", "--background-tertiary",
            "--background-base-lowest", "--background-base-lower", "--background-base-low", "--background-surface-high", "--background-surface-higher",
            "--background-modifier-hover", "--background-modifier-active", "--background-modifier-selected", "--background-modifier-accent",
            "--text-normal", "--text-muted", "--text-default", "--text-primary", "--text-secondary",
            "--header-primary", "--header-secondary", "--channels-default",
            "--interactive-normal", "--interactive-hover", "--interactive-active", "--interactive-muted",
            "--border-subtle", "--border-normal", "--border-strong", "--focus-primary",
            "--brand-500", "--brand-experiment", "--status-positive", "--status-danger",
            "--button-secondary-background", "--button-secondary-background-hover",
            "--scrollbar-auto-thumb", "--scrollbar-auto-track"
        ];
        for (const token of themeTokens) {
            const value = nativeStyle.getPropertyValue(token).trim();
            if (value) this.dashboard.style.setProperty(token, value);
            else this.dashboard.style.removeProperty(token);
        }
    }

    collectGuilds() {
        let ordered = [];
        try {
            const ids = this.SortedGuildStore?.getFlattenedGuildIds?.() || [];
            ordered = ids.map(id => this.GuildStore?.getGuild?.(id)).filter(Boolean);
        } catch (_) {}
        if (!ordered.length) {
            try { ordered = Object.values(this.GuildStore?.getGuilds?.() || {}); } catch (_) {}
        }
        return ordered.map((guild, index) => this.getGuildMetadata(guild, index));
    }

    getGuildChannels(guildId) {
        const channels = new Map(), seen = new Set();
        const collect = (value, depth = 0) => {
            if (!value || depth > 5 || seen.has(value)) return;
            if (typeof value === "object") seen.add(value);
            const channel = value?.channel || value;
            if (channel?.id && (channel.guild_id === guildId || channel.guildId === guildId || channel.guild_id == null && channel.guildId == null)) channels.set(channel.id, channel);
            if (Array.isArray(value)) value.forEach(item => collect(item, depth + 1));
            else if (typeof value === "object") Object.values(value).forEach(item => collect(item, depth + 1));
        };
        try { collect(this.GuildChannelStore?.getChannels?.(guildId)); } catch (_) {}
        try { collect(this.GuildChannelStore?.getSelectableChannelIds?.(guildId)?.map(id => this.ChannelStore?.getChannel?.(id))); } catch (_) {}
        try { collect(this.ChannelStore?.getMutableGuildChannelsForGuild?.(guildId)); } catch (_) {}
        return [...channels.values()];
    }

    getActiveStageState(guildId, stageChannels) {
        try {
            if (this.StageInstanceStore?.getStageInstanceByGuild?.(guildId)) return true;
            if (stageChannels.some(channel => this.StageInstanceStore?.getStageInstanceByChannel?.(channel.id))) return true;
            const instances = this.StageInstanceStore?.getStageInstancesForGuild?.(guildId) || this.StageInstanceStore?.getStageInstances?.();
            const instanceList = instances instanceof Map ? [...instances.values()] : Array.isArray(instances) ? instances : Object.values(instances || {});
            if (instanceList.some(instance => (instance?.guild_id || instance?.guildId) === guildId)) return true;
        } catch (_) {}
        const eventList = [];
        const addEvents = value => {
            const list = value instanceof Map ? [...value.values()] : Array.isArray(value) ? value : Object.values(value || {});
            eventList.push(...list.flatMap(item => Array.isArray(item) ? item : [item]));
        };
        for (const producer of [
            () => this.ScheduledEventStore?.getGuildScheduledEvents?.(guildId),
            () => this.ScheduledEventStore?.getGuildScheduledEventsForGuild?.(guildId),
            () => this.ScheduledEventStore?.getGuildScheduledEventsByIndex?.(guildId),
            () => this.ScheduledEventStore?.getEventsForGuild?.(guildId),
            () => this.ScheduledEventStore?.getAllGuildScheduledEvents?.()
        ]) try { addEvents(producer()); } catch (_) {}
        return eventList.some(event => {
            const eventGuildId = event?.guild_id || event?.guildId;
            return (!eventGuildId || eventGuildId === guildId) && Number(event?.status) === 2 && (Number(event?.entity_type ?? event?.entityType) === 1 || stageChannels.some(channel => channel.id === (event?.channel_id || event?.channelId)));
        });
    }

    getGuildMetadata(guild, index = 0) {
        const id = guild.id;
        const preview = this.previewCache?.get(id);
        let mentions = 0, unread = false, members = 0, online = 0, inVoice = false, onStage = false, voices = [], voiceCount = 0;
        try { mentions = this.ReadStore?.getMentionCount?.(id) || 0; } catch (_) {}
        try { unread = !!this.ReadStore?.hasUnread?.(id); } catch (_) {}
        try { members = this.MemberCountStore?.getMemberCount?.(id) || guild.memberCount || guild.member_count || guild.approximateMemberCount || guild.approximate_member_count || 0; } catch (_) {}
        try { online = this.PresenceStore?.getGuildPresenceCount?.(id) || this.PresenceStore?.getOnlineCount?.(id) || this.MemberCountStore?.getOnlineCount?.(id) || guild.presenceCount || guild.presence_count || guild.approximatePresenceCount || guild.approximate_presence_count || 0; } catch (_) {}
        if (preview) {
            members ||= preview.members || 0;
            online ||= preview.online || 0;
        }
        try {
            const channels = this.getGuildChannels(id);
            const voiceChannels = channels.filter(channel => Number(channel.type) === 2);
            const stageChannels = channels.filter(channel => Number(channel.type) === 13);
            const states = [];
            const stateSeen = new Set();
            const stateScope = new Map();
            let voiceMembersActive = false, stageMembersActive = false;
            const addStates = (value, fallbackGuildId = null) => {
                if (!value) return;
                if (Array.isArray(value)) return value.forEach(item => addStates(item, fallbackGuildId));
                if (typeof value !== "object") return;
                if (stateSeen.has(value)) return;
                stateSeen.add(value);
                if (value.userId || value.user_id || value.sessionId || value.session_id || value.channelId || value.channel_id) {
                    states.push(value);
                    if (fallbackGuildId) stateScope.set(value, fallbackGuildId);
                }
                else Object.values(value).forEach(item => addStates(item, fallbackGuildId));
            };
            const readStates = (producer, fallbackGuildId = null) => { try { addStates(producer?.(), fallbackGuildId); } catch (_) {} };
            readStates(() => this.VoiceStore?.getVoiceStatesForGuild?.(id), id);
            readStates(() => this.VoiceStateStore?.getVoiceStatesForGuild?.(id), id);
            readStates(() => this.SortedVoiceStore?.getVoiceStatesForGuild?.(id), id);
            readStates(() => this.VoiceStateStore?.getAllVoiceStates?.());
            readStates(() => this.SortedVoiceStore?.getAllVoiceStates?.());
            readStates(() => this.VoiceStateStore?.getVoiceStates?.());
            readStates(() => this.SortedVoiceStore?.getVoiceStates?.());
            for (const channel of [...voiceChannels, ...stageChannels]) {
                readStates(() => this.VoiceStateStore?.getVoiceStatesForChannel?.(channel.id), id);
                readStates(() => this.VoiceStateStore?.getVoiceStatesForChannel?.(channel), id);
                readStates(() => this.SortedVoiceStore?.getVoiceStatesForChannel?.(channel.id), id);
                readStates(() => this.SortedVoiceStore?.getVoiceStatesForChannel?.(channel), id);
                let channelMembers = null;
                try { channelMembers = this.VoiceMemberStore?.getVoiceChannelMembers?.(channel.id) || this.VoiceMemberStore?.getVoiceChannelMembers?.(channel) || this.VoiceMemberStore?.getVoiceStatesForChannel?.(channel.id) || this.VoiceMemberStore?.getVoiceStatesForChannel?.(channel); } catch (_) {}
                if (!channelMembers) {
                    try { channelMembers = this.ChannelMemberStore?.getMemberIds?.(channel.id) || this.ChannelMemberStore?.getMembers?.(channel.id) || this.ChannelMemberStore?.getChannelMembers?.(channel.id); } catch (_) {}
                }
                let memberCount = channelMembers instanceof Map ? channelMembers.size : Array.isArray(channelMembers) ? channelMembers.length : Object.keys(channelMembers || {}).length;
                if (!memberCount) {
                    try { memberCount = Number(this.ChannelMemberStore?.getMemberCount?.(channel.id) || this.VoiceMemberStore?.getMemberCount?.(channel.id)) || 0; } catch (_) {}
                }
                if (memberCount) {
                    if (Number(channel.type) === 13) stageMembersActive = true;
                    else voiceMembersActive = true;
                }
            }
            const stateChannelType = state => {
                const channelId = state?.channelId || state?.channel_id;
                if (!channelId) return null;
                try { return Number(this.ChannelStore?.getChannel?.(channelId)?.type); } catch (_) { return null; }
            };
            const guildScopedStates = states.filter(state => {
                const stateGuildId = state?.guildId || state?.guild_id;
                const channelId = state?.channelId || state?.channel_id;
                let channelGuildId = null;
                try { const channel = channelId && this.ChannelStore?.getChannel?.(channelId); channelGuildId = channel?.guild_id || channel?.guildId; } catch (_) {}
                const scopedGuildId = stateGuildId || channelGuildId || stateScope.get(state);
                return scopedGuildId === id;
            });
            inVoice = voiceMembersActive || guildScopedStates.some(state => {
                const type = stateChannelType(state);
                return type === 2 || type == null;
            });
            onStage = stageMembersActive || guildScopedStates.some(state => stateChannelType(state) === 13) || this.getActiveStageState(id, stageChannels);
            const allVoices = guildScopedStates.map(state => {
                const userId = state?.userId || state?.user_id;
                const user = userId ? this.UserStore?.getUser?.(userId) : null;
                return user ? {id:user.id, name:user.globalName || user.username || "User", avatar:user.getAvatarURL?.(null, 32, true) || null} : null;
            }).filter((voice, index, list) => voice && list.findIndex(item => item?.id === voice.id) === index);
            voiceCount = allVoices.length;
            voices = allVoices.slice(0, 4);
        } catch (_) {}
        let icon = null;
        try { icon = guild.getIconURL?.(128, true) || null; } catch (_) {}
        if (!icon && guild.icon) {
            const extension = String(guild.icon).startsWith("a_") ? "gif" : "webp";
            icon = `https://cdn.discordapp.com/icons/${id}/${guild.icon}.${extension}?size=128`;
        }
        let description = this.guildDescription(guild);
        try {
            const profile = this.GuildProfileStore?.getGuildProfile?.(id);
            description ||= this.guildDescription(profile);
        } catch (_) {}
        description ||= preview?.description || "";
        return {id, name: guild.name || "Unknown Server", description, icon,
            mentions, unread, members, online, inVoice, onStage, voices, voiceCount, index};
    }

    collectFolders(guildMap) {
        let folders = [];
        try { folders = this.SortedGuildStore?.getGuildFolders?.() || []; } catch (_) {}
        return folders.filter(f => (f.guildIds || []).length > 1 || f.folderId).map((f, i) => ({
            id: String(f.folderId || `folder-${i}`), name: f.folderName || "Folder", color: f.folderColor,
            guilds: (f.guildIds || []).map(id => guildMap.get(id)).filter(Boolean)
        })).filter(f => f.guilds.length);
    }

    applySearchAndFilters(guilds) {
        const q = this.query.trim().toLocaleLowerCase();
        let result = guilds.filter(g => !q || `${g.name} ${g.description}`.toLocaleLowerCase().includes(q));
        const fav = new Set(this.settings.favoriteGuildIds);
        if (this.filter === "unread") result = result.filter(g => g.unread);
        if (this.filter === "mentions") result = result.filter(g => g.mentions > 0);
        if (this.filter === "favorites") result = result.filter(g => fav.has(g.id));
        if (this.filter === "voice") result = result.filter(g => g.inVoice);
        if (this.filter === "stage") result = result.filter(g => g.onStage);
        const recent = new Map(this.settings.recentGuildIds.map((id, i) => [id, i]));
        const sorts = {
            alphabetical: (a, b) => a.name.localeCompare(b.name),
            recent: (a, b) => (recent.get(a.id) ?? 9999) - (recent.get(b.id) ?? 9999),
            unread: (a, b) => Number(b.unread) - Number(a.unread) || b.mentions - a.mentions,
            mentions: (a, b) => b.mentions - a.mentions || Number(b.unread) - Number(a.unread),
            discord: (a, b) => a.index - b.index
        };
        return result.sort(sorts[this.sort] || sorts.discord);
    }

    renderDashboard() {
        if (!this.dashboard) return;
        const content = this.dashboard.querySelector(".sd-content");
        const all = this.collectGuilds();
        const map = new Map(all.map(g => [g.id, g]));
        const visible = this.applySearchAndFilters(all);
        const availableWidth = Math.max(140, (content?.clientWidth || innerWidth) - 68);
        const autoRecentCapacity = Math.max(1, Math.floor((availableWidth + 12) / 152));
        const recentCapacity = this.settings.recentServersMode === "fixed" ? this.settings.maxRecentServers : autoRecentCapacity;
        if (!this.settings.recentHistoryInitialized) {
            const known = new Set(this.settings.recentGuildIds);
            this.settings.recentGuildIds = [...this.settings.recentGuildIds, ...all.map(g => g.id).filter(id => !known.has(id))].slice(0, 50);
            this.settings.recentHistoryInitialized = true;
            this.saveSettings();
        }
        const recent = this.settings.recentGuildIds.map(id => map.get(id)).filter(Boolean).slice(0, recentCapacity);
        const favoriteServers = this.settings.favoriteGuildIds.map(id => map.get(id)).filter(Boolean);
        const canShowFavorites = this.settings.showFavorites;
        const canShowRecent = this.settings.showRecentServers;
        if (this.homeSection === "favorites" && !canShowFavorites) this.homeSection = "recent";
        if (this.homeSection === "recent" && !canShowRecent && canShowFavorites) this.homeSection = "favorites";
        const homeSectionTabs = canShowFavorites && canShowRecent ? `<div class="sd-home-section-tabs"><button class="sd-home-section-tab ${this.homeSection === "favorites" ? "sd-active" : ""}" data-home-section="favorites">Favorites</button><button class="sd-home-section-tab ${this.homeSection === "recent" ? "sd-active" : ""}" data-home-section="recent">Recent Servers</button></div>` : "";
        const homeServerSection = this.homeSection === "favorites" && canShowFavorites
            ? `<section><div class="sd-section-title"><h2>Favorite Servers</h2></div><div class="sd-favorite-dropzone ${favoriteServers.length ? "sd-recent" : "sd-section-empty"}" data-favorite-dropzone>${favoriteServers.length ? favoriteServers.map(g => this.serverTile(g, true)).join("") : `Drag a server here or use its star button to add it to Favorites.`}</div></section>`
            : canShowRecent ? `<section><div class="sd-section-title sd-recent-title"><h2>Recent Servers</h2><button class="sd-clear-history" data-action="clear-recent" type="button" ${recent.length ? "" : "disabled"}>Clear History</button></div>${recent.length ? `<div class="sd-recent">${recent.map(g => this.serverTile(g, true)).join("")}</div>` : `<div class="sd-section-empty">Your recently opened servers will appear here.</div>`}</section>` : "";
        const folders = this.collectFolders(map).filter(f => !this.query || f.name.toLowerCase().includes(this.query.toLowerCase()) || f.guilds.some(g => visible.includes(g)));
        const expandedFolder = folders.find(folder => this.expandedFolders.has(folder.id));
        const unreadCount = all.filter(g => g.unread).length;
        const mentionCount = all.reduce((n, g) => n + g.mentions, 0);
        if (this.filter === "unread" && !this.settings.showUnreadIndicators || this.filter === "mentions" && !this.settings.showMentionIndicators) this.filter = "all";
        const serverSectionTitle = ({all:"All Servers", unread:"Unread", mentions:"Mentions", favorites:"Favorites", voice:"In Voice", stage:"On Stage"})[this.filter] || "All Servers";
        this.renderSidebar(all, unreadCount, mentionCount);
        content.innerHTML = `
            <div class="sd-toolbar"><label class="sd-search-wrap"><span>⌕</span><input class="sd-search" type="search" value="${this.esc(this.query)}" placeholder="Search servers and folders" aria-label="Search servers and folders"></label>
            <select class="sd-sort" aria-label="Sort servers">${this.options({discord:"Discord order",recent:"Recently opened",alphabetical:"Alphabetical",unread:"Unread first",mentions:"Mention count"}, this.sort)}</select></div>
            <div class="sd-filter-row">${homeSectionTabs}${homeSectionTabs ? `<span class="sd-filter-separator" aria-hidden="true"></span>` : ""}<div class="sd-chips">${this.chip("all","All Servers")} ${this.settings.showUnreadIndicators ? this.chip("unread",`Unread ${unreadCount || ""}`) : ""} ${this.settings.showMentionIndicators ? this.chip("mentions",`Mentions ${mentionCount || ""}`) : ""} ${this.chip("voice","In Voice")} ${this.chip("stage","On Stage")}</div></div>
            ${homeServerSection}
            ${this.settings.showFolders && folders.length ? `<section><div class="sd-section-title"><h2>Folders</h2></div><div class="sd-folders">${folders.map(f => this.folderCard(f)).join("")}</div>${expandedFolder ? this.expandedFolderPanel(expandedFolder) : ""}</section>` : ""}
            <section><div class="sd-section-title sd-all-servers-title"><h2>${serverSectionTitle}</h2><span>${visible.length} server${visible.length === 1 ? "" : "s"}</span><button class="sd-preview-refresh ${this.previewRefreshAnimating ? "sd-refreshing" : ""}" data-action="refresh-previews" type="button" aria-label="Reload server descriptions" title="Reload server descriptions"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.65 6.35A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.76-4.24L13 11h8V3l-3.35 3.35Z"/></svg></button></div><div class="sd-server-grid ${this.settings.showDescriptions ? "" : "sd-compact-cards"}">${visible.length ? visible.map(g => this.serverCard(g)).join("") : `<div class="sd-empty">No servers match this view.</div>`}</div></section>`;
        if (this.settings.showFavorites) content.querySelectorAll(".sd-recent-tile[data-guild-id],.sd-server-card[data-guild-id]").forEach(card => card.draggable = true);
        const search = content.querySelector(".sd-search");
        search?.addEventListener("input", e => {
            this.query = e.target.value;
            this.searchSelection = [e.target.selectionStart ?? this.query.length, e.target.selectionEnd ?? this.query.length];
            this.scheduleRender();
        });
        content.querySelector(".sd-sort")?.addEventListener("change", e => { this.sort = e.target.value; this.scheduleRender(); });
        if (this.searchSelection) {
            const nextSearch = content.querySelector(".sd-search");
            const [start, end] = this.searchSelection;
            this.searchSelection = null;
            nextSearch?.focus({preventScroll:true});
            try { nextSearch?.setSelectionRange(start, end); } catch (_) {}
        }
        if (this.settings.showDescriptions) this.queueGuildPreviews(all);
    }

    queueGuildPreviews(guilds) {
        if (this.stopped || (!this.HTTP?.get && !this.PreviewActions && !this.ProfileActions && !BdApi.Net?.fetch)) return;
        for (const guild of guilds) {
            if (guild.description || this.previewCache.get(guild.id)?.fresh || this.previewQueued.has(guild.id)) continue;
            this.previewQueued.add(guild.id);
            this.previewQueue.push(guild.id);
        }
        this.pumpGuildPreviews();
    }

    refreshGuildPreviews() {
        const guilds = this.collectGuilds();
        this.previewQueue = guilds.map(guild => guild.id);
        this.previewQueued = new Set(this.previewQueue);
        for (const guild of guilds) {
            const cached = this.previewCache.get(guild.id);
            if (cached) cached.fresh = false;
        }
        this.previewRefreshing = true;
        this.previewRefreshAnimating = true;
        this.previewErrorShown = false;
        clearTimeout(this.previewAnimationTimer);
        this.previewAnimationTimer = setTimeout(() => {
            this.previewRefreshAnimating = false;
            if (!this.stopped && this.open) this.scheduleRender();
        }, 2000);
        this.scheduleRender();
        this.pumpGuildPreviews();
    }

    pumpGuildPreviews() {
        if (this.stopped || this.previewActive || !this.previewQueue.length) return;
        const id = this.previewQueue.shift();
        this.previewActive = 1;
        let nextDelay = 350;
        this.loadGuildPreview(id, this.previewRefreshing)
            .then(body => {
                const cachedDescription = this.previewCache.get(id)?.description || "";
                this.previewCache.set(id, {
                    description: this.guildDescription(body),
                    online: Number(body?.approximate_presence_count ?? body?.approximatePresenceCount ?? body?.presence_count ?? body?.presenceCount) || 0,
                    members: Number(body?.approximate_member_count ?? body?.approximateMemberCount ?? body?.member_count ?? body?.memberCount) || 0,
                    fresh:true
                });
                if (!this.previewCache.get(id).description && cachedDescription) this.previewCache.get(id).description = cachedDescription;
                if (this.previewCache.get(id).description) this.scheduleDescriptionCacheSave();
                if (!this.stopped && this.open) this.scheduleRender();
            })
            .catch(error => {
                if (error?.status === 429) {
                    this.previewQueue.unshift(id);
                    nextDelay = Math.max(1000, error.retryAfter || 5000);
                    return;
                }
                const cachedDescription = this.previewCache.get(id)?.description || "";
                this.previewCache.set(id, {description:cachedDescription, online:0, members:0, fresh:true});
                if (!this.previewErrorShown) {
                    this.previewErrorShown = true;
                    const detail = error?.message || "Unknown request error";
                    BdApi.UI.showToast(`Server preview data failed: ${detail}`, {type:"error", timeout:8000});
                }
            })
            .finally(() => {
                this.previewActive = 0;
                if (this.previewRefreshing && !this.previewQueue.length) {
                    this.previewRefreshing = false;
                    if (!this.stopped && this.open) this.scheduleRender();
                }
                clearTimeout(this.previewPumpTimer);
                this.previewPumpTimer = setTimeout(() => this.pumpGuildPreviews(), nextDelay);
            });
    }

    async loadGuildPreview(id, force = false) {
        const unwrap = value => value?.body || value?.guild || value?.preview || value?.guildProfile || value?.guild_profile || value?.profile || value;
        const readStores = () => unwrap(this.GuildPreviewStore?.getGuildPreview?.(id)) || unwrap(this.GuildProfileStore?.getGuildProfile?.(id));
        let body = readStores();
        if (!force && this.guildDescription(body)) return body;
        const previewFn = this.PreviewActions?.fetchGuildPreview || this.PreviewActions?.requestGuildPreview;
        if (previewFn) {
            try { body = unwrap(await previewFn.call(this.PreviewActions, id)) || readStores(); } catch (_) {}
            if (!force && this.guildDescription(body)) return body;
        }
        const profileFn = this.ProfileActions?.fetchGuildProfile || this.ProfileActions?.requestGuildProfile;
        if (profileFn) {
            try { body = unwrap(await profileFn.call(this.ProfileActions, id)) || readStores(); } catch (_) {}
            if (!force && this.guildDescription(body)) return body;
        }
        if (this.HTTP?.get) {
            try {
                body = unwrap(await this.HTTP.get({url:`/guilds/${id}/preview`, retries:0}));
                if (this.guildDescription(body) || body?.approximate_presence_count || body?.approximatePresenceCount) return body;
            } catch (_) {}
        }
        const token = this.AuthenticationStore?.getToken?.();
        if (BdApi.Net?.fetch) {
            const headers = {Accept:"application/json"};
            if (token) headers.Authorization = token;
            const response = await BdApi.Net.fetch(`https://discord.com/api/v10/guilds/${id}/preview`, {
                method:"GET", timeout:10000, headers
            });
            const status = response?.statusCode ?? response?.status;
            if (response?.ok === true || (status >= 200 && status < 300)) {
                if (typeof response.json === "function") return await response.json();
                if (typeof response.text === "function") return JSON.parse(await response.text());
                if (typeof response.body === "string") return JSON.parse(response.body);
                if (response.body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(response.body));
                const chunks = Array.isArray(response.content) ? response.content : [response.content];
                const length = chunks.reduce((sum, chunk) => sum + (chunk?.byteLength || chunk?.length || 0), 0);
                const bytes = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    if (!chunk) continue;
                    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    bytes.set(view, offset); offset += view.byteLength;
                }
                return JSON.parse(new TextDecoder().decode(bytes));
            }
            if (status === 429) {
                const headerValue = response?.headers?.get?.("retry-after") ?? response?.headers?.get?.("x-ratelimit-reset-after") ?? response?.headers?.["retry-after"] ?? response?.headers?.["Retry-After"] ?? response?.headers?.["x-ratelimit-reset-after"];
                let retryAfter = Number(headerValue) * 1000;
                try {
                    const rateBody = typeof response.json === "function" ? await response.json() : typeof response.body === "string" ? JSON.parse(response.body) : null;
                    if (rateBody?.retry_after) retryAfter = Number(rateBody.retry_after) * 1000;
                } catch (_) {}
                const error = new Error("Discord API rate limited");
                error.status = 429;
                error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5000;
                throw error;
            }
            throw new Error(`Discord API ${status || response?.statusText || "request failed"}`);
        }
        return body || {};
    }

    currentUserName() {
        try { return this.UserStore?.getCurrentUser?.()?.globalName || this.UserStore?.getCurrentUser?.()?.username || ""; } catch (_) { return ""; }
    }

    renderSidebar(all, unreadCount, mentionCount) {
        const sidebar = this.dashboard.querySelector(".sd-sidebar");
        if (!sidebar) return;
        const favorites = this.settings.favoriteGuildIds.map(id => all.find(g => g.id === id)).filter(Boolean).slice(0, 5);
        sidebar.innerHTML = `
            <button class="sd-dm-search" data-action="friends">Find or start a conversation</button>
            <nav class="sd-side-nav">
                ${this.sideNavItem("home", "Home", "M4 12 12 5l8 7v8a2 2 0 0 1-2 2h-4v-6h-4v6H6a2 2 0 0 1-2-2v-8Z", true)}
                ${this.sideNavItem("friends", "Friends", "M16 11c1.66 0 3-1.57 3-3.5S17.66 4 16 4s-3 1.57-3 3.5 1.34 3.5 3 3.5ZM8 11c1.66 0 3-1.57 3-3.5S9.66 4 8 4 5 5.57 5 7.5 6.34 11 8 11Zm8 2c-2 0-6 1.16-6 3.5V20h12v-3.5C22 14.16 18 13 16 13ZM8 13c-2.33 0-7 1.17-7 3.5V20h7v-3.5c0-.85.33-1.58.89-2.2A8.66 8.66 0 0 0 8 13Z")}
                ${this.sideNavItem("requests", "Message Requests", "M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H8l-5 3V5Zm3 2 6 4 6-4H6Z")}
                ${this.sideNavItem("nitro", "Nitro", "M7 4h10l4 8-4 8H7l-4-8 4-8Zm2.4 4L7 12l2.4 4h5.2L17 12l-2.4-4H9.4Z")}
                ${this.sideNavItem("shop", "Shop", "M3 9l2-6h14l2 6v2a3 3 0 0 1-2 2v8H5v-8a3 3 0 0 1-2-2V9Zm5 4v5h8v-5H8Z", false, "NEW")}
                ${this.sideNavItem("quests", "Quests", "M12 2 9.5 6.5 4 7l4 4-1 6 5-2.5L17 17l-1-6 4-4-5.5-.5L12 2Z")}
            </nav>
            <div class="sd-native-divider"></div>
            <div class="sd-dm-heading"><span>Favorites</span><b>＋</b></div>
            <div class="sd-favorite-list">${favorites.length ? favorites.map(g => `<button data-guild-id="${g.id}">${this.icon(g,"sm")}<span>${this.esc(g.name)}</span>${g.mentions ? `<b>${g.mentions}</b>` : ""}</button>`).join("") : `<p class="sd-side-empty">Favorite servers appear here.</p>`}</div>
            <div class="sd-profile"><div class="sd-avatar">${this.esc((this.currentUserName() || "U")[0].toUpperCase())}</div><span><strong>${this.esc(this.currentUserName() || "Discord User")}</strong><small>Online</small></span><b>⚙</b></div>`;
    }

    sideNavItem(action, label, path, active = false, badge = "") {
        const fallback = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"/></svg>`;
        const icon = action === "home" ? fallback : (this.getNativeMenuIcon(label) || fallback);
        return `<button class="${active ? "sd-side-active " : ""}sd-nav-${action}" data-action="${action}">${icon}<span>${label}</span>${badge ? `<b class="sd-nav-badge">${badge}</b>` : ""}</button>`;
    }

    getNativeMenuIcon(label) {
        const controls = [...document.querySelectorAll('a,button,[role="link"],[role="button"],[data-list-item-id]')];
        const control = controls.find(node => !this.dashboard.contains(node) && node.textContent.trim().replace(/\s+/g, " ").startsWith(label));
        const svg = control?.querySelector("svg");
        if (!svg) return "";
        const clone = svg.cloneNode(true);
        clone.removeAttribute("id");
        clone.setAttribute("aria-hidden", "true");
        return clone.outerHTML;
    }

    icon(g, size = "lg") {
        const acronym = g.name.split(/\s+/).slice(0, 3).map(x => x[0]).join("").toUpperCase();
        return g.icon ? `<img class="sd-icon sd-${size}" src="${this.esc(g.icon)}" alt="">` : `<span class="sd-icon sd-${size} sd-acronym">${this.esc(acronym)}</span>`;
    }

    badges(g) {
        return `${this.settings.showUnreadIndicators && g.unread ? `<span class="sd-unread" title="Unread"></span>` : ""}${this.settings.showMentionIndicators && g.mentions ? `<span class="sd-mention" title="${g.mentions} mentions">${g.mentions > 99 ? "99+" : g.mentions}</span>` : ""}`;
    }

    serverTile(g) {
        const favorite = this.settings.favoriteGuildIds.includes(g.id);
        return `<article class="sd-recent-tile" data-guild-id="${g.id}" tabindex="0" role="button"><div class="sd-recent-indicators">${this.settings.showFavorites ? `<button class="sd-favorite ${favorite ? "sd-is-favorite" : ""}" data-action="favorite" aria-label="${favorite ? "Remove from" : "Add to"} favorites">★</button>` : `<span></span>`}<div class="sd-recent-badges">${this.badges(g)}</div></div>${this.icon(g)}<div class="sd-tile-name">${this.esc(g.name)}</div></article>`;
    }

    serverCard(g) {
        const favorite = this.settings.favoriteGuildIds.includes(g.id);
        const description = g.description;
        const extraVoiceUsers = Math.max(0, Number(g.voiceCount || 0) - (g.voices?.length || 0));
        return `<article class="sd-server-card" data-guild-id="${g.id}" tabindex="0" role="button">
            <div class="sd-card-top"><div class="sd-card-indicators">${this.settings.showFavorites ? `<button class="sd-favorite sd-card-favorite ${favorite ? "sd-is-favorite" : ""}" data-action="favorite" aria-label="Toggle favorite">★</button>` : `<span></span>`}<div class="sd-card-badges">${this.badges(g)}</div></div>${this.icon(g)}</div>
            <div class="sd-server-info"><h3>${this.esc(g.name)}</h3></div>
            ${this.settings.showDescriptions && description ? `<p class="sd-description">${this.esc(description)}</p>` : ""}
            <div class="sd-card-actions"><div class="sd-voice-avatars">${this.settings.showVoiceActivity && g.voices?.length ? `${g.voices.map(v => v.avatar ? `<img src="${this.esc(v.avatar)}" alt="${this.esc(v.name)}" title="${this.esc(v.name)}">` : `<span>${this.esc(v.name[0])}</span>`).join("")}${extraVoiceUsers ? `<small>+${extraVoiceUsers}</small>` : ""}` : ""}</div></div>
            <div class="sd-server-stats"><span class="sd-online-dot"></span>${this.compact(g.online || 0)} Online${this.settings.showMemberCounts && g.members ? `<span class="sd-member-dot"></span>${this.compact(g.members)} Members` : ""}</div>
        </article>`;
    }

    folderCard(folder) {
        const expanded = this.expandedFolders.has(folder.id);
        const color = Number.isFinite(folder.color) ? `#${folder.color.toString(16).padStart(6,"0")}` : "var(--brand-500, #5865f2)";
        return `<article class="sd-folder-card ${expanded ? "sd-folder-active" : ""}" data-folder-id="${this.esc(folder.id)}"><button class="sd-folder-head" data-action="folder" aria-expanded="${expanded}"><span class="sd-folder-color" style="--sd-folder-color:${color}"></span><span><strong>${this.esc(folder.name)}</strong><small>${folder.guilds.length} servers</small></span><span class="sd-folder-icons">${folder.guilds.slice(0,4).map(g => this.icon(g,"sm")).join("")}</span><span class="sd-chevron">⌄</span></button></article>`;
    }

    expandedFolderPanel(folder) {
        const color = Number.isFinite(folder.color) ? `#${folder.color.toString(16).padStart(6,"0")}` : "var(--brand-500, #5865f2)";
        return `<div class="sd-folder-expanded" data-folder-id="${this.esc(folder.id)}"><div class="sd-folder-expanded-title"><span class="sd-folder-color" style="--sd-folder-color:${color}"></span><strong>${this.esc(folder.name)}</strong><small>${folder.guilds.length} servers</small></div><div class="sd-folder-server-grid">${folder.guilds.map(g => this.serverTile(g)).join("")}</div></div>`;
    }

    chip(id, label) { return `<button class="sd-chip ${this.filter === id ? "sd-active" : ""}" data-filter="${id}">${label.trim()}</button>`; }
    options(items, selected) { return Object.entries(items).map(([v,l]) => `<option value="${v}" ${v === selected ? "selected" : ""}>${l}</option>`).join(""); }

    handleDragStart(e) {
        const card = e.target.closest("[data-guild-id]");
        if (!card || !this.settings.showFavorites) return;
        this.dragGuildId = card.dataset.guildId;
        card.classList.add("sd-dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", this.dragGuildId);
    }

    handleDragOver(e) {
        const zone = e.target.closest("[data-favorite-dropzone]");
        if (!zone || !this.dragGuildId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        zone.classList.add("sd-drag-over");
    }

    handleDragLeave(e) {
        const zone = e.target.closest("[data-favorite-dropzone]");
        if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("sd-drag-over");
    }

    handleDrop(e) {
        const zone = e.target.closest("[data-favorite-dropzone]");
        if (!zone) return;
        e.preventDefault();
        const id = this.dragGuildId || e.dataTransfer.getData("text/plain");
        if (!id) return this.finishDrag();
        const targetId = e.target.closest("[data-guild-id]")?.dataset.guildId;
        if (targetId === id) return this.finishDrag();
        const favorites = this.settings.favoriteGuildIds.filter(guildId => guildId !== id);
        const targetIndex = targetId ? favorites.indexOf(targetId) : -1;
        if (targetIndex >= 0) favorites.splice(targetIndex, 0, id);
        else favorites.push(id);
        this.settings.favoriteGuildIds = favorites;
        this.saveSettings();
        this.finishDrag();
        this.renderDashboard();
    }

    finishDrag() {
        this.dragGuildId = null;
        this.suppressCardClickUntil = Date.now() + 200;
        this.dashboard?.querySelectorAll(".sd-dragging,.sd-drag-over").forEach(node => node.classList.remove("sd-dragging", "sd-drag-over"));
    }

    handleClick(e) {
        if (Date.now() < (this.suppressCardClickUntil || 0)) return;
        const windowAction = e.target.closest("[data-window]")?.dataset.window;
        if (windowAction) return this.controlWindow(windowAction);
        const action = e.target.closest("[data-action]")?.dataset.action;
        if (this.expandedFolders.size && action !== "folder") {
            this.expandedFolders.clear();
            this.dashboard.querySelector(".sd-folder-expanded")?.remove();
            const activeFolder = this.dashboard.querySelector(".sd-folder-active");
            activeFolder?.classList.remove("sd-folder-active");
            activeFolder?.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", "false");
        }
        if (action === "close") return this.closeDashboard();
        if (action === "inbox" || action === "help") return this.openNativeDestination(action);
        if (action === "refresh-previews") return this.refreshGuildPreviews();
        if (action === "clear-recent") {
            this.settings.recentGuildIds = [];
            this.settings.recentHistoryInitialized = true;
            this.saveSettings();
            return this.renderDashboard();
        }
        if (action === "home") { this.filter = "all"; this.query = ""; return this.renderDashboard(); }
        if (["friends", "requests", "nitro", "shop", "quests"].includes(action)) {
            return this.openNativeDestination(action);
        }
        const homeSection = e.target.closest("[data-home-section]")?.dataset.homeSection;
        if (homeSection) { this.homeSection = homeSection; return this.renderDashboard(); }
        const chip = e.target.closest("[data-filter]");
        if (chip) { this.filter = chip.dataset.filter; return this.renderDashboard(); }
        const folder = e.target.closest("[data-folder-id]");
        if (action === "folder" && folder) {
            if (this.expandedFolders.has(folder.dataset.folderId)) this.expandedFolders.clear();
            else { this.expandedFolders.clear(); this.expandedFolders.add(folder.dataset.folderId); }
            return this.renderDashboard();
        }
        const guild = e.target.closest("[data-guild-id]");
        if (!guild) return;
        if (action === "favorite") { e.stopPropagation(); return this.toggleFavorite(guild.dataset.guildId); }
        this.openGuild(guild.dataset.guildId);
    }

    controlWindow(action) {
        try {
            const windowApi = globalThis.DiscordNative?.window;
            if (action === "minimize") windowApi?.minimize?.();
            else if (action === "maximize") (windowApi?.maximize || windowApi?.toggleMaximize)?.call(windowApi);
            else if (action === "close") windowApi?.close?.();
        } catch (error) { this.log("Window action unavailable", action, error); }
    }

    openNativeDestination(action) {
        const labels = {friends:"Friends", requests:"Message Requests", nitro:"Nitro", shop:"Shop", quests:"Quests", inbox:"Inbox", help:"Help"};
        const routes = {friends:"/channels/@me", requests:"/message-requests", nitro:"/store", shop:"/shop", quests:"/quest-home"};
        const label = labels[action];
        const candidates = [...document.querySelectorAll('a,button,[role="link"],[role="button"],[data-list-item-id]')];
        const nativeControl = candidates.find(node => !this.dashboard.contains(node) && (node.getAttribute("aria-label") === label || node.textContent.trim().replace(/\s+/g, " ").startsWith(label)));
        if (!nativeControl && !routes[action]) return;
        this.closeDashboard();
        if (nativeControl) {
            nativeControl.click();
            return;
        }
        try {
            if (!this.navigateSpa(routes[action])) BdApi.UI.showToast(`Could not open ${label}.`, {type:"error"});
        } catch (_) { BdApi.UI.showToast(`Could not open ${label}.`, {type:"error"}); }
    }

    handleKey(e) {
        if ((e.key === "Enter" || e.key === " ") && e.target.matches("[data-guild-id]")) {
            e.preventDefault(); this.openGuild(e.target.dataset.guildId);
        }
    }

    toggleFavorite(id) {
        const list = this.settings.favoriteGuildIds;
        this.settings.favoriteGuildIds = list.includes(id) ? list.filter(x => x !== id) : [id, ...list];
        this.saveSettings(); this.renderDashboard();
    }

    recordRecentGuild(id, render = true) {
        if (!id) return;
        this.settings.recentGuildIds = [id, ...this.settings.recentGuildIds.filter(x => x !== id)].slice(0, 50);
        this.saveSettings();
        if (render) this.scheduleRender();
    }

    getGuildRoute(id) {
        const live = [...document.querySelectorAll("a[href]")].find(a => {
            const href = a.getAttribute("href") || "";
            return href.startsWith(`/channels/${id}/`) && href.split("/").filter(Boolean).length >= 3;
        });
        if (live) return live.getAttribute("href");
        let channel;
        try {
            channel = this.DefaultChannelStore?.getDefaultChannel?.(id) || null;
            const defaultId = this.DefaultChannelStore?.getDefaultChannelId?.(id);
            if (!channel && defaultId) channel = this.ChannelStore?.getChannel?.(defaultId);
            if (!channel) {
                const source = this.GuildChannelStore?.getChannels?.(id) || this.GuildChannelStore?.getMutableGuildChannelsForGuild?.(id) || this.ChannelStore?.getChannels?.(id) || {};
                const values = [];
                const seen = new Set();
                const visit = (value, depth = 0) => {
                    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return;
                    seen.add(value);
                    if (value.id && (value.guild_id === id || value.guildId === id)) { values.push(value); return; }
                    if (value.channel) visit(value.channel, depth + 1);
                    else for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child, depth + 1);
                };
                visit(source);
                channel = values.find(c => c?.id && (c.type === 0 || c.type === 5 || c.type === 15)) || values.find(c => c?.id);
            }
        } catch (_) {}
        return channel ? `/channels/${id}/${channel.id}` : null;
    }

    getNativeGuildControl(id) {
        const guildNav = document.querySelector('[data-list-id="guildsnav"]');
        if (!guildNav) return null;
        const item = [...guildNav.querySelectorAll("[data-list-item-id],a[href]")].find(node => {
            const itemId = node.getAttribute("data-list-item-id") || "";
            const href = node.getAttribute("href") || "";
            return itemId.endsWith(`___${id}`) || itemId.includes(`guildsnav___${id}`) || href === `/channels/${id}` || href.startsWith(`/channels/${id}/`);
        });
        return item?.closest('a,button,[role="treeitem"],[role="link"]') || item;
    }

    navigateSpa(route) {
        if (!route) return false;
        try {
            if (this.Navigation?.transitionTo) { this.Navigation.transitionTo(route); return true; }
            if (this.History?.push) { this.History.push(route); return true; }
            window.history.pushState({}, "", route);
            window.dispatchEvent(new PopStateEvent("popstate", {state:window.history.state}));
            return true;
        } catch (error) { this.log("SPA navigation failed", route, error); return false; }
    }

    openGuild(id) {
        this.recordRecentGuild(id);
        const nativeControl = this.getNativeGuildControl(id);
        if (nativeControl) {
            try {
                nativeControl.click();
                this.closeWhenGuildReady(id);
                return;
            }
            catch (error) { this.log("Native guild navigation failed", error); }
        }
        const route = this.getGuildRoute(id);
        if (!route) { BdApi.UI.showToast("Discord could not find an accessible channel for that server.", {type:"error"}); return; }
        try {
            if (!this.navigateSpa(route)) { BdApi.UI.showToast("Could not open that server.", {type:"error"}); return; }
            this.closeWhenGuildReady(id);
        } catch (error) { this.log(error); BdApi.UI.showToast("Could not open that server.", {type:"error"}); }
    }

    closeWhenGuildReady(id) {
        clearTimeout(this.guildOpenTimer);
        const started = Date.now();
        const check = () => {
            if (!this.open || this.stopped) return;
            let selected = false;
            try { selected = this.SelectedGuildStore?.getGuildId?.() === id; } catch (_) {}
            const routeReady = location.pathname.startsWith(`/channels/${id}/`);
            const loading = document.body.innerText.includes("DID YOU KNOW");
            const elapsed = Date.now() - started;
            if ((selected && routeReady && !loading && elapsed >= 600) || elapsed >= 6000) {
                this.closeDashboard();
                return;
            }
            this.guildOpenTimer = setTimeout(check, 150);
        };
        this.guildOpenTimer = setTimeout(check, 300);
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.className = "sd-settings";
        const switchRow = (key, label, note = "", extra = "") => `<label class="sd-setting" ${extra}><span><strong>${label}</strong>${note ? `<small>${note}</small>` : ""}</span><input class="sd-switch-input" type="checkbox" data-key="${key}" ${this.settings[key] ? "checked" : ""}><span class="sd-switch-control" aria-hidden="true"><span></span></span></label>`;
        const section = (title, description, content) => `<section class="sd-settings-section"><header><h3>${title}</h3>${description ? `<p>${description}</p>` : ""}</header>${content}</section>`;
        panel.innerHTML = [
            section("General", "Controls how the Home dashboard is added to Discord.",
                switchRow("showHomeButton", "Show Home button", "Adds Home above Friends in the Direct Messages sidebar.")),
            section("Home sections", "Choose which server collections appear near the top of Home.",
                switchRow("showRecentServers", "Show Recent Servers", "Displays servers you opened most recently.") +
                `<div data-recent-options ${this.settings.showRecentServers ? "" : "hidden"}><label class="sd-setting"><span><strong>Recent Servers count</strong><small>Auto fits the available width; Fixed uses your chosen amount.</small></span><select data-key="recentServersMode"><option value="auto" ${this.settings.recentServersMode === "auto" ? "selected" : ""}>Auto</option><option value="fixed" ${this.settings.recentServersMode === "fixed" ? "selected" : ""}>Fixed</option></select></label><label class="sd-setting" data-recent-count ${this.settings.recentServersMode === "auto" ? "hidden" : ""}><span><strong>Fixed server count</strong><small>Number of cards shown in Recent Servers.</small></span><input type="number" min="1" max="50" data-key="maxRecentServers" value="${this.settings.maxRecentServers}"></label></div>` +
                switchRow("showFolders", "Show Folders", "Displays your native Discord server folders.")),
            section("Favorites", "Controls starred servers and the default collection shown when Home opens.",
                switchRow("showFavorites", "Enable Favorites", "Shows favorite stars and enables drag-and-drop favorites.") +
                switchRow("showFavoritesByDefault", "Show Favorites by default", "Opens Home on Favorites instead of Recent Servers.", `data-favorites-default ${this.settings.showFavorites ? "" : "hidden"}`)),
            section("Server cards", "Controls the information displayed inside cards in All Servers.",
                switchRow("showDescriptions", "Show server descriptions", "Displays Discord server profile descriptions when available.") +
                switchRow("showMemberCounts", "Show member counts", "Displays total member counts beside online counts.") +
                switchRow("showVoiceActivity", "Show voice activity", "Displays detected voice participants at the bottom of server cards.")),
            section("Activity and filters", "Choose which notification indicators and matching filter tabs appear on Home.",
                switchRow("showUnreadIndicators", "Show unread status", "Displays unread dots and the Unread filter.") +
                switchRow("showMentionIndicators", "Show mention counts", "Displays red mention badges and the Mentions filter.")),
            section("Advanced", "Troubleshooting options intended for development and support.",
                switchRow("debug", "Debug logging", "Writes additional Home Page diagnostics to Discord's developer console."))
        ].join("");
        panel.addEventListener("change", e => {
            const key = e.target.dataset.key; if (!key) return;
            if (e.target.type === "checkbox") this.settings[key] = e.target.checked;
            else if (key === "maxRecentServers") this.settings[key] = Math.max(1, Math.min(50, Number(e.target.value) || 8));
            else this.settings[key] = e.target.value;
            if (key === "recentServersMode") panel.querySelector("[data-recent-count]").hidden = this.settings.recentServersMode === "auto";
            if (key === "showRecentServers") panel.querySelector("[data-recent-options]").hidden = !this.settings.showRecentServers;
            if (key === "showFavorites") panel.querySelector("[data-favorites-default]").hidden = !this.settings.showFavorites;
            this.saveSettings();
            if (key === "showHomeButton") { this.createHomeButton(); this.createNativeSidebarHome(); }
            if (this.open) this.renderDashboard();
        });
        return panel;
    }

    guildDescription(value) {
        const candidates = [value, value?.profile, value?.guildProfile, value?.guild_profile, value?.guild, value?.preview];
        for (const source of candidates) {
            if (!source || typeof source !== "object") continue;
            for (const key of ["description", "bio", "about", "summary", "tagline"]) {
                if (typeof source[key] === "string" && source[key].trim()) return source[key].trim();
            }
        }
        return "";
    }

    compact(n) { return Intl.NumberFormat(undefined, {notation:"compact", maximumFractionDigits:1}).format(n); }
    esc(value) { return String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

    styles() { return `
.sd-home-button{width:48px;height:48px;min-height:48px;margin:8px auto;border:0;border-radius:16px;background:var(--background-secondary,#2b2d31);color:var(--interactive-normal,#b5bac1);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:background .16s,border-radius .16s,color .16s}.sd-home-button:hover,.sd-home-button:focus-visible{background:var(--brand-500,#5865f2);color:#fff;border-radius:12px;outline:none}.sd-home-button svg{width:24px;height:24px}
.sd-dashboard[hidden]{display:none!important}.sd-dashboard{position:fixed;inset:0 0 0 72px;z-index:100;display:flex;flex-direction:column;font-family:var(--font-primary,"gg sans",sans-serif);color:var(--text-normal,#dbdee1);background:var(--sd-native-content-bg,var(--background-base-low,#1a1a1e))}.sd-shell{width:100%;min-height:0;flex:1;display:grid;grid-template-columns:240px minmax(0,1fr);overflow:hidden;background:var(--sd-native-content-bg,var(--background-base-low,#1a1a1e))}.sd-content{height:100%;box-sizing:border-box;overflow:auto;padding:34px 34px 52px;background:var(--sd-native-content-bg,var(--background-base-low,#1a1a1e))}.sd-header h1{font-size:25px;line-height:1.1;margin:0 0 9px;color:var(--header-primary,#f2f3f5)}.sd-header h2{font-size:22px;margin:0 0 5px;color:var(--header-primary,#f2f3f5)}.sd-header p{margin:0;color:var(--text-muted,#949ba4)}
.sd-titlebar{height:32px;min-height:32px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.06));background:var(--background-base-lowest,#111214);-webkit-app-region:drag;user-select:none}.sd-titlebar-name{justify-self:center;display:flex;align-items:center;gap:7px;color:var(--header-primary,#f2f3f5);font-size:12px;font-weight:600;line-height:16px}.sd-titlebar-name svg{width:16px;height:16px;color:var(--interactive-normal,#b5bac1)}.sd-title-actions{height:32px;justify-self:end;display:flex;align-items:center;-webkit-app-region:no-drag}.sd-title-actions>button{display:grid;place-items:center;width:36px;height:32px;padding:0;border:0;background:transparent;color:var(--interactive-normal,#b5bac1);cursor:pointer}.sd-title-actions>button svg{width:18px;height:18px}.sd-title-actions>button:hover{color:var(--interactive-hover,#dbdee1)}.sd-title-separator{width:1px;height:18px;margin:0 4px;background:var(--border-subtle,rgba(255,255,255,.1))}.sd-window-actions{height:32px;display:flex}.sd-window-actions button{display:grid;place-items:center;width:36px;height:32px;padding:0;border:0;background:transparent;color:var(--interactive-normal,#b5bac1);cursor:pointer}.sd-window-actions button:hover{background:var(--background-modifier-hover,rgba(78,80,88,.45));color:#fff}.sd-window-actions button:last-child:hover{background:#da373c}.sd-minimize{width:10px;height:1px;background:currentColor}.sd-maximize{width:9px;height:9px;border:1px solid currentColor;box-sizing:border-box}.sd-window-close{font-size:20px;font-weight:200;line-height:1}.sd-dm-search{height:32px;margin:0 0 9px;padding:0 10px;border:0;border-radius:4px;background:var(--background-base-lowest,#111214);box-shadow:0 1px 0 rgba(0,0,0,.2);color:var(--text-muted,#949ba4);font-size:12px;font-weight:600;text-align:left;cursor:pointer}.sd-side-nav button svg{width:20px;height:20px;flex:0 0 auto}.sd-side-nav button>span{flex:1}.sd-nav-badge{padding:2px 6px;border-radius:9px;background:var(--text-normal,#dbdee1);color:var(--background-base-low,#1a1a1e);font-size:9px}.sd-native-divider{height:1px;margin:12px 8px;background:var(--border-subtle,rgba(255,255,255,.08))}.sd-dm-heading{display:flex;justify-content:space-between;padding:4px 9px 7px;color:var(--channels-default,#949ba4);font-size:11px;text-transform:uppercase}.sd-dm-heading b{font-size:17px;font-weight:400}.sd-sidebar{padding:8px;background:var(--background-base-lower,var(--background-secondary,#121214));border-right:0}.sd-side-nav{gap:2px}.sd-side-nav button{height:42px;padding:0 9px;border-radius:4px;font-size:15px}.sd-side-nav button:hover,.sd-side-nav .sd-side-active{background:var(--background-modifier-selected,rgba(78,80,88,.6));color:var(--interactive-active,#fff)}.sd-favorite-list button{height:42px;border-radius:4px}.sd-profile{margin:8px -8px -8px;padding:8px;border:0;border-radius:0;background:var(--background-base-lowest,var(--background-secondary-alt,#111214))}
.sd-native-home-active{filter:drop-shadow(0 0 8px rgba(88,101,242,.8))}.sd-dashboard-selected{background:var(--background-modifier-selected,rgba(78,80,88,.6))!important;color:var(--interactive-active,#fff)!important}.sd-dashboard-selected *{color:var(--interactive-active,#fff)!important}.sd-native-selection-suppressed{background:transparent!important;color:var(--channels-default,#949ba4)!important}.sd-native-selection-suppressed *{color:var(--channels-default,#949ba4)!important}.sd-native-sidebar-home-clone svg{width:22px!important;height:22px!important}.sd-native-sidebar-home-wrap{list-style:none;margin:0;padding:0 8px 2px}.sd-native-sidebar-home{width:100%;height:42px;display:flex;align-items:center;gap:12px;padding:0 10px;border:0;border-radius:4px;background:transparent;color:var(--channels-default,#949ba4);font-family:var(--font-primary,"gg sans",sans-serif);font-size:16px;font-weight:500;line-height:20px;text-align:left;cursor:pointer}.sd-native-sidebar-home svg{width:22px;height:22px;flex:0 0 auto}.sd-native-sidebar-home:hover{background:var(--background-modifier-hover,rgba(78,80,88,.35));color:var(--interactive-hover,#dbdee1)}.sd-sidebar{height:100%;box-sizing:border-box;display:flex;flex-direction:column;padding:20px 13px 14px;border-right:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));background:var(--sd-native-sidebar-bg,var(--background-base-lower,#121214));overflow-y:auto}.sd-brand{display:flex;align-items:center;gap:12px;padding:0 6px 20px;font-size:20px;color:var(--header-primary,#f2f3f5)}.sd-brand>span{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:linear-gradient(145deg,#7180ff,#4338d8);color:#fff;font-weight:800;box-shadow:0 0 18px rgba(88,101,242,.35)}.sd-side-nav{display:grid;gap:5px}.sd-side-nav button,.sd-voice-row,.sd-favorite-list button{width:100%;display:flex;align-items:center;gap:10px;border:0;border-radius:8px;padding:9px 10px;background:transparent;color:var(--text-muted,#949ba4);font:inherit;text-align:left;cursor:pointer}.sd-side-nav button:hover,.sd-side-nav .sd-side-active{background:var(--background-modifier-selected,rgba(78,80,88,.6));color:#fff}.sd-side-label{margin:20px 9px 7px;color:var(--channels-default,#949ba4);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}.sd-side-panel,.sd-summary{padding:9px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.07));border-radius:10px;background:rgba(255,255,255,.025)}.sd-side-panel-title{display:flex;justify-content:space-between;padding:1px 2px 8px;color:#3ba55c;font-size:13px}.sd-voice-row{padding:6px 2px;color:var(--text-normal,#dbdee1)}.sd-voice-row>span{min-width:0;flex:1}.sd-voice-row strong,.sd-voice-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sd-voice-row strong{font-size:12px}.sd-voice-row small{font-size:10px;color:var(--text-muted,#949ba4)}.sd-join{width:100%;margin-top:7px;padding:7px;border:0;border-radius:6px;background:#248046;color:#fff;font-weight:700;cursor:pointer}.sd-summary{display:grid;gap:3px}.sd-summary button{display:flex;justify-content:space-between;border:0;padding:7px;background:transparent;color:var(--text-muted,#949ba4);cursor:pointer}.sd-summary b,.sd-favorite-list b{min-width:18px;padding:2px 4px;border-radius:6px;background:var(--status-danger,#da373c);color:#fff;text-align:center;font-size:10px}.sd-favorite-list{display:grid;gap:2px}.sd-favorite-list button{padding:5px 7px}.sd-favorite-list button span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.sd-side-empty{padding:3px 4px;margin:0;color:var(--text-muted,#949ba4);font-size:11px}.sd-profile{display:flex;align-items:center;gap:9px;margin-top:auto;padding:10px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:9px;background:rgba(255,255,255,.025)}.sd-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--brand-500,#5865f2);font-weight:700}.sd-profile>span{min-width:0;flex:1}.sd-profile strong,.sd-profile small{display:block;font-size:11px}.sd-profile small{color:#3ba55c}
.sd-toolbar{display:flex;gap:12px;margin:24px 0 12px}.sd-search-wrap{flex:1;height:44px;display:flex;align-items:center;gap:9px;padding:0 14px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:10px;background:var(--background-secondary,#2b2d31)}.sd-search-wrap:focus-within{border-color:var(--brand-500,#5865f2)}.sd-search{width:100%;border:0;outline:0;background:transparent;color:var(--text-normal,#dbdee1);font:inherit}.sd-sort{min-width:180px;padding:0 12px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:10px;background:var(--background-secondary,#2b2d31);color:var(--text-normal,#dbdee1)}.sd-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:28px}.sd-chip{border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:20px;padding:7px 12px;background:var(--background-secondary,#2b2d31);color:var(--text-muted,#949ba4);cursor:pointer}.sd-chip:hover,.sd-chip.sd-active{color:#fff;background:var(--brand-500,#5865f2);border-color:transparent}
.sd-home-section-tabs{display:flex;gap:8px;margin:0 0 8px}.sd-home-section-tab{padding:7px 12px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:20px;background:var(--background-secondary,#2b2d31);color:var(--text-muted,#949ba4);font:inherit;cursor:pointer}.sd-home-section-tab:hover,.sd-home-section-tab.sd-active{color:#fff;background:var(--brand-500,#5865f2);border-color:transparent}.sd-section-empty{padding:18px;border:1px dashed var(--background-modifier-accent,rgba(255,255,255,.12));border-radius:10px;color:var(--text-muted,#949ba4)}
.sd-filter-row{display:flex;align-items:center;gap:8px;margin-bottom:28px;overflow-x:auto}.sd-filter-row .sd-home-section-tabs,.sd-filter-row .sd-chips{flex:0 0 auto;margin:0}.sd-filter-row button{white-space:nowrap}
.sd-filter-row .sd-home-section-tab,.sd-filter-row .sd-chip{padding:7px 12px;border:0;border-radius:8px;background:transparent;color:var(--interactive-normal,#b5bac1);font-family:var(--font-primary,"gg sans",sans-serif);font-size:16px;line-height:20px;font-weight:500}.sd-filter-row .sd-home-section-tab:hover,.sd-filter-row .sd-chip:hover{background:var(--background-modifier-hover,rgba(78,80,88,.35));color:var(--interactive-hover,#dbdee1)}.sd-filter-row .sd-home-section-tab.sd-active,.sd-filter-row .sd-chip.sd-active{background:var(--background-modifier-selected,rgba(78,80,88,.6));color:var(--interactive-active,#fff)}.sd-filter-separator{width:1px;height:24px;flex:0 0 1px;margin:0 4px;background:var(--interactive-muted,#4e5058)}
.sd-favorite-dropzone{min-height:145px;box-sizing:border-box;transition:border-color .15s,background-color .15s}.sd-favorite-dropzone.sd-section-empty{display:flex;align-items:center;justify-content:center}.sd-favorite-dropzone.sd-drag-over{border:1px dashed var(--brand-500,#5865f2);border-radius:12px;background:color-mix(in srgb,var(--brand-500,#5865f2) 12%,transparent)}.sd-dragging{opacity:.45}
.sd-section-title{display:flex;align-items:baseline;gap:9px;margin:25px 0 12px}.sd-section-title h2{font-size:18px;margin:0;color:var(--header-primary,#f2f3f5)}.sd-section-title span{font-size:12px;color:var(--text-muted,#949ba4)}.sd-recent{display:flex;gap:12px;overflow-x:auto;padding:2px 1px 8px}.sd-recent-tile{position:relative;flex:0 0 126px;box-sizing:border-box;min-height:145px;padding:17px 10px 12px;text-align:center;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:14px;background:var(--background-secondary,#2b2d31);cursor:pointer}.sd-recent-tile:hover,.sd-recent-tile:focus-visible{border-color:var(--brand-500,#5865f2);outline:none;background:var(--background-secondary-alt,#232428)}.sd-tile-name{margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600}.sd-icon{display:inline-flex;align-items:center;justify-content:center;object-fit:cover;background:var(--brand-500,#5865f2);color:#fff}.sd-icon.sd-lg{width:64px;height:64px;border-radius:20px;font-size:16px}.sd-icon.sd-sm{width:28px;height:28px;border-radius:9px;font-size:9px}.sd-acronym{font-weight:700}.sd-unread{width:8px;height:8px;border-radius:50%;background:#fff;display:inline-block}.sd-mention{display:inline-flex;min-width:18px;height:18px;padding:0 4px;box-sizing:border-box;align-items:center;justify-content:center;border-radius:9px;background:var(--status-danger,#da373c);color:#fff;font-size:11px;font-weight:700}.sd-recent-tile>.sd-unread,.sd-recent-tile>.sd-mention{position:absolute;top:10px;right:10px}.sd-recent-tile>.sd-unread+.sd-mention{top:23px}
.sd-folders{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}.sd-folder-card{border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:14px;background:var(--background-secondary,#2b2d31);overflow:hidden}.sd-folder-head{width:100%;display:flex;align-items:center;gap:12px;padding:15px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.sd-folder-color{width:6px;height:42px;border-radius:4px;background:var(--sd-folder-color)}.sd-folder-head strong,.sd-folder-head small{display:block}.sd-folder-head small{margin-top:3px;color:var(--text-muted,#949ba4)}.sd-folder-icons{margin-left:auto;display:flex}.sd-folder-icons .sd-icon{margin-left:-7px;box-shadow:0 0 0 2px var(--background-secondary,#2b2d31)}.sd-chevron{margin-left:5px;color:var(--text-muted,#949ba4)}.sd-folder-servers{display:flex;gap:10px;overflow-x:auto;padding:0 14px 14px}.sd-folder-servers .sd-recent-tile{flex-basis:112px;min-height:132px}
.sd-server-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(265px,1fr));gap:13px}.sd-server-card{min-height:130px;box-sizing:border-box;padding:17px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.08));border-radius:14px;background:var(--background-secondary,#2b2d31);cursor:pointer}.sd-server-card:hover,.sd-server-card:focus-visible{border-color:var(--brand-500,#5865f2);outline:none;background:var(--background-secondary-alt,#232428)}.sd-card-top{display:flex;align-items:center;gap:12px}.sd-server-info{min-width:0;flex:1}.sd-server-info h3{margin:0 0 4px;color:var(--header-primary,#f2f3f5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sd-status{font-size:12px;color:var(--text-muted,#949ba4)}.sd-description{color:var(--text-muted,#949ba4);font-size:13px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.sd-card-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}.sd-favorite{border:0;background:transparent;color:var(--interactive-muted,#4e5058);font-size:19px;cursor:pointer}.sd-favorite:hover,.sd-favorite.sd-is-favorite{color:#f0b232}.sd-recent-tile>.sd-favorite{position:absolute;left:5px;top:5px}.sd-open-button{border:0;border-radius:7px;padding:6px 12px;background:var(--brand-500,#5865f2);color:#fff;font-weight:600;cursor:pointer}.sd-empty{grid-column:1/-1;padding:45px;text-align:center;border:1px dashed var(--background-modifier-accent,rgba(255,255,255,.12));border-radius:14px;color:var(--text-muted,#949ba4)}
.sd-settings{padding:10px 0 2px;color:var(--text-normal,#dbdee1);font-family:var(--font-primary,"gg sans",sans-serif);font-size:16px;line-height:20px}.sd-setting{position:relative;min-height:32px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:20px;padding:4px 0;color:var(--text-normal,#dbdee1);cursor:default}.sd-setting>span:first-child{min-width:0;flex:1}.sd-switch-input{position:absolute;right:0;width:40px;height:24px;opacity:0;cursor:pointer}.sd-switch-control{position:relative;width:40px;height:24px;flex:0 0 40px;border-radius:12px;background:var(--background-modifier-accent,#4e5058);transition:background-color .15s;pointer-events:none}.sd-switch-control>span{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .15s}.sd-switch-input:checked+.sd-switch-control{background:var(--brand-500,#5865f2)}.sd-switch-input:checked+.sd-switch-control>span{transform:translateX(16px)}.sd-switch-input:focus-visible+.sd-switch-control{outline:2px solid var(--focus-primary,#00a8fc);outline-offset:2px}.sd-setting input[type=number]{width:80px;box-sizing:border-box;padding:7px 9px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.1));border-radius:6px;background:var(--background-secondary,#2b2d31);color:inherit;font:inherit}.sd-setting select{min-width:110px;padding:7px 30px 7px 10px;border:1px solid var(--background-modifier-accent,rgba(255,255,255,.1));border-radius:6px;background-color:var(--background-secondary,#2b2d31);color:inherit;font:inherit}.sd-setting[hidden]{display:none}
.sd-settings-section{padding:0 0 18px}.sd-settings-section+.sd-settings-section{padding-top:18px;border-top:1px solid var(--background-modifier-accent,rgba(255,255,255,.08))}.sd-settings-section>header{margin-bottom:8px}.sd-settings-section h3{margin:0;color:var(--header-primary,#f2f3f5);font-size:16px;line-height:20px;font-weight:700}.sd-settings-section header p{margin:3px 0 0;color:var(--text-muted,#949ba4);font-size:13px;line-height:17px}.sd-settings-section .sd-setting{min-height:42px;padding:5px 0}.sd-setting strong{display:block;font-size:15px;line-height:19px;font-weight:500}.sd-setting small{display:block;margin-top:2px;color:var(--text-muted,#949ba4);font-size:12px;line-height:16px;font-weight:400}.sd-settings-section [data-recent-options][hidden]{display:none}
.sd-dashboard{background:transparent;pointer-events:none}.sd-shell{pointer-events:auto}.sd-titlebar{position:relative;width:calc(100% - 216px);background:transparent;pointer-events:none}.sd-titlebar::before{content:"";position:absolute;inset:0;background:var(--background-base-lowest,#111214)}.sd-titlebar-name{position:fixed;z-index:1;top:0;left:50%;height:32px;font-size:14px;line-height:18px;font-weight:600;transform:translateX(-50%);pointer-events:none}.sd-titlebar-name svg{width:18px;height:18px}.sd-title-actions{display:none!important}
.sd-folder-head strong{font-family:var(--font-display,var(--font-primary,"gg sans",sans-serif));font-size:16px;line-height:20px;font-weight:700;color:var(--header-primary,#f2f3f5)}.sd-folder-head small{font-family:var(--font-primary,"gg sans",sans-serif);font-size:13px;line-height:17px;font-weight:400}
.sd-folder-card.sd-folder-active{border-color:var(--brand-500,#5865f2)}.sd-folder-active .sd-chevron{transform:rotate(180deg)}.sd-folder-expanded{width:100%;box-sizing:border-box;margin-top:12px;padding:14px;border:1px solid var(--border-subtle,var(--background-modifier-accent,rgba(255,255,255,.08)));border-radius:12px;background:var(--background-base-lower,var(--background-secondary,#202225))}.sd-folder-expanded-title{display:flex;align-items:center;gap:10px;margin-bottom:12px}.sd-folder-expanded-title .sd-folder-color{width:5px;height:28px}.sd-folder-expanded-title strong{font-family:var(--font-display,var(--font-primary,"gg sans",sans-serif));font-size:16px;line-height:20px;font-weight:700}.sd-folder-expanded-title small{color:var(--text-muted,#949ba4);font-size:12px}.sd-folder-server-grid{display:grid;grid-template-columns:repeat(auto-fill,140px);gap:10px;align-items:stretch}.sd-folder-server-grid .sd-recent-tile{width:140px;min-width:140px;max-width:140px;min-height:140px;box-sizing:border-box}.sd-chevron{transition:transform .15s ease}
.sd-search{font-family:var(--font-primary,"gg sans",sans-serif);font-size:16px;line-height:20px;color:var(--text-normal,#dbdee1)}.sd-search::placeholder{color:var(--interactive-normal,#b5bac1);opacity:1}.sd-search-wrap>span{color:var(--interactive-normal,#b5bac1);font-size:17px}.sd-chip{font-family:var(--font-primary,"gg sans",sans-serif);font-size:14px;line-height:18px;font-weight:500}.sd-sort{-webkit-appearance:none;appearance:none;height:44px;padding:0 44px 0 14px;font-family:var(--font-primary,"gg sans",sans-serif);font-size:16px;line-height:20px;font-weight:400;color:var(--text-normal,#dbdee1);background-color:var(--background-secondary,#2b2d31);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24'%3E%3Cpath d='m7 10 5 5 5-5' fill='none' stroke='%23b5bac1' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 16px center;background-size:14px 14px}
.sd-section-title h2{font-family:var(--font-display,var(--font-primary,"gg sans",sans-serif));font-size:20px;line-height:24px;font-weight:700;letter-spacing:0;color:var(--header-primary,#f2f3f5)}.sd-section-title>span{font-family:var(--font-primary,"gg sans",sans-serif);font-size:12px;font-weight:400}.sd-content,.sd-recent,.sd-folder-servers{scrollbar-width:thin;scrollbar-color:var(--scrollbar-auto-thumb,#1a1b1e) var(--scrollbar-auto-track,transparent)}.sd-content::-webkit-scrollbar,.sd-recent::-webkit-scrollbar,.sd-folder-servers::-webkit-scrollbar{width:10px;height:10px}.sd-content::-webkit-scrollbar-track,.sd-recent::-webkit-scrollbar-track,.sd-folder-servers::-webkit-scrollbar-track{background:var(--scrollbar-auto-track,transparent);border-radius:8px}.sd-content::-webkit-scrollbar-thumb,.sd-recent::-webkit-scrollbar-thumb,.sd-folder-servers::-webkit-scrollbar-thumb{min-height:40px;background:var(--scrollbar-auto-thumb,#1a1b1e);border:2px solid transparent;border-radius:8px;background-clip:padding-box}.sd-content::-webkit-scrollbar-corner,.sd-recent::-webkit-scrollbar-corner,.sd-folder-servers::-webkit-scrollbar-corner{background:transparent}
.sd-all-servers-title{align-items:center}.sd-preview-refresh{width:32px;height:32px;margin-left:auto;padding:6px;border:0;border-radius:6px;display:grid;place-items:center;background:transparent;color:var(--interactive-normal,#b5bac1);cursor:pointer}.sd-preview-refresh:hover{background:var(--background-modifier-hover,rgba(78,80,88,.35));color:var(--interactive-hover,#dbdee1)}.sd-preview-refresh:disabled{cursor:default}.sd-preview-refresh svg{width:20px;height:20px}.sd-preview-refresh.sd-refreshing svg{animation:sd-preview-spin .9s linear infinite}@keyframes sd-preview-spin{to{transform:rotate(360deg)}}
.sd-recent-title{align-items:center}.sd-clear-history{margin-left:auto;padding:5px 9px;border:0;border-radius:5px;background:transparent;color:var(--interactive-normal,#b5bac1);font:inherit;font-size:13px;cursor:pointer}.sd-clear-history:hover{background:var(--background-modifier-hover,rgba(78,80,88,.35));color:var(--interactive-hover,#dbdee1)}.sd-clear-history:disabled{opacity:.45;cursor:default;background:transparent}
.sd-recent>.sd-recent-tile{width:140px;min-width:140px;max-width:140px;flex:0 0 140px;overflow:hidden}.sd-recent>.sd-recent-tile .sd-tile-name{height:36px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal;line-height:18px;overflow:hidden;text-overflow:ellipsis}
.sd-recent-indicators{position:absolute;top:7px;left:7px;right:7px;display:flex;align-items:center;justify-content:space-between;min-height:24px}.sd-recent-indicators .sd-favorite{width:24px;height:24px;padding:0;display:grid;place-items:center;font-size:24px;line-height:24px}.sd-recent-badges{display:flex;align-items:center;gap:4px;min-height:20px}
.sd-recent-badges{align-self:flex-start;min-width:18px;flex-direction:column;align-items:center;justify-content:flex-start;gap:4px}.sd-recent-badges .sd-mention{order:1;margin-top:4px}.sd-recent-badges .sd-unread{order:2;flex:0 0 auto}.sd-recent-badges .sd-unread:only-child{margin-top:8px}
.sd-server-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.sd-server-card{position:relative;min-height:220px;padding:14px;display:flex;flex-direction:column;border-radius:10px;background:var(--background-base-lower,var(--background-secondary,#202225));border-color:var(--border-subtle,rgba(255,255,255,.08));font-family:var(--font-primary,"gg sans",sans-serif)}.sd-server-card:hover,.sd-server-card:focus-visible{background:var(--background-modifier-hover,var(--background-secondary-alt,#232428));border-color:var(--border-strong,rgba(255,255,255,.14))}.sd-server-card .sd-card-top{min-height:58px;align-items:flex-start}.sd-server-card .sd-icon.sd-lg{width:56px;height:56px;border-radius:16px}.sd-card-badges{margin-left:auto;display:flex;align-items:center;gap:5px}.sd-server-card .sd-server-info{margin-top:9px}.sd-server-card .sd-server-info h3{font-family:var(--font-display,var(--font-primary,"gg sans",sans-serif));font-size:16px;line-height:20px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sd-title-star{margin-left:5px;color:#f0b232;font-size:13px}.sd-server-card .sd-description{min-height:36px;margin:4px 0 9px;font-size:14px;line-height:18px;font-weight:400;-webkit-line-clamp:2}.sd-server-stats{min-height:16px;display:flex;align-items:center;gap:5px;color:var(--text-muted,#949ba4);font-size:12px;line-height:16px;font-weight:400;white-space:nowrap;overflow:hidden}.sd-online-dot{width:7px;height:7px;border-radius:50%;background:var(--status-positive,#23a55a);flex:0 0 auto}.sd-server-card .sd-card-actions{margin-top:auto;min-height:28px;align-items:center}.sd-voice-avatars{display:flex;align-items:center;min-width:0;margin-right:auto}.sd-voice-avatars img,.sd-voice-avatars>span{width:22px;height:22px;box-sizing:border-box;margin-right:-5px;border:2px solid var(--background-base-lower,var(--background-secondary,#202225));border-radius:50%;object-fit:cover;background:var(--brand-500,#5865f2);color:#fff;display:grid;place-items:center;font-size:9px}.sd-voice-avatars small{height:22px;min-width:22px;box-sizing:border-box;margin-left:7px;padding:0 4px;display:grid;place-items:center;border:1px solid var(--border-subtle,rgba(255,255,255,.12));border-radius:11px;color:var(--text-muted,#949ba4);font-size:10px}.sd-server-card .sd-favorite{padding:3px 5px}.sd-server-card .sd-open-button{padding:6px 13px;background:var(--button-secondary-background,#4e5058);font-size:12px;line-height:16px;font-weight:700}.sd-server-card .sd-open-button:hover{background:var(--button-secondary-background-hover,#6d6f78)}
.sd-server-card .sd-card-top{position:relative;justify-content:center;align-items:center}.sd-server-card .sd-card-top>.sd-icon{margin:0 auto}.sd-card-indicators{position:absolute;inset:0 0 auto;display:flex;align-items:center;justify-content:space-between;min-height:24px}.sd-server-card .sd-card-favorite{position:static;width:24px;height:24px;margin:0;padding:0;display:grid;place-items:center;font-size:24px;line-height:24px}.sd-server-card .sd-card-badges{position:static;margin:0;min-height:20px}.sd-server-card .sd-description{color:var(--text-normal,#dbdee1)}.sd-server-card .sd-card-actions{margin-top:auto;min-height:22px}.sd-server-card .sd-server-stats{margin-top:7px;color:var(--header-primary,#f2f3f5)}.sd-member-dot{width:7px;height:7px;margin-left:7px;border-radius:50%;background:var(--text-muted,#949ba4);flex:0 0 auto}
.sd-compact-cards .sd-server-card{min-height:160px}.sd-compact-cards .sd-card-actions{min-height:0}.sd-compact-cards .sd-server-info{width:100%;flex:none;text-align:center}.sd-compact-cards .sd-server-info h3{width:100%;text-align:center!important}
.sd-server-grid .sd-server-info{width:100%;box-sizing:border-box}.sd-server-grid .sd-server-info h3{width:100%;text-align:center!important}
.sd-dashboard{color:var(--sd-normal-text,var(--text-normal,#dbdee1))}.sd-content,.sd-shell{background:var(--sd-surface,var(--sd-native-content-bg,var(--background-primary,#1a1a1e)))}.sd-section-title h2,.sd-server-info h3,.sd-tile-name,.sd-folder-head strong{color:var(--sd-strong-text,var(--header-primary,#f2f3f5))}.sd-section-title span,.sd-folder-head small,.sd-description,.sd-server-stats{color:var(--sd-muted-text,var(--text-muted,#949ba4))}.sd-search-wrap,.sd-sort{background-color:var(--sd-control-surface,var(--background-secondary,#2b2d31));border-color:var(--sd-card-border,var(--border-subtle,rgba(255,255,255,.08)));color:var(--sd-normal-text,var(--text-normal,#dbdee1))}.sd-search,.sd-search::placeholder{color:var(--sd-muted-text,var(--interactive-normal,#b5bac1))}.sd-recent-tile,.sd-folder-card,.sd-folder-expanded,.sd-server-card{background:var(--sd-card-surface,var(--background-secondary,#2b2d31));border-color:var(--sd-card-border,var(--border-subtle,rgba(255,255,255,.08)))}.sd-recent-tile:hover,.sd-recent-tile:focus-visible,.sd-server-card:hover,.sd-server-card:focus-visible{background:var(--sd-card-hover,var(--background-modifier-hover,#35363c));border-color:var(--sd-card-border-hover,var(--border-strong,rgba(255,255,255,.18)))}.sd-folder-icons .sd-icon,.sd-voice-avatars img,.sd-voice-avatars>span{box-shadow:0 0 0 2px var(--sd-card-surface,var(--background-secondary,#2b2d31));border-color:var(--sd-card-surface,var(--background-secondary,#2b2d31))}.sd-home-section-tab,.sd-chip{color:var(--sd-muted-text,var(--interactive-normal,#b5bac1))}.sd-home-section-tab:hover,.sd-chip:hover{color:var(--sd-strong-text,var(--interactive-hover,#fff));background:var(--sd-control-surface,var(--background-modifier-hover,#35363c))}.sd-home-section-tab.sd-active,.sd-chip.sd-active{color:var(--sd-strong-text,var(--interactive-active,#fff));background:var(--sd-control-surface,var(--background-modifier-selected,#3f4147))}
.sd-dashboard[data-sd-palette="light"] .sd-server-card .sd-description{color:#4e5058}.sd-dashboard[data-sd-palette="light"] .sd-server-card .sd-server-stats{color:#313338}.sd-dashboard[data-sd-palette="light"] .sd-filter-row .sd-home-section-tab,.sd-dashboard[data-sd-palette="light"] .sd-filter-row .sd-chip{color:#4e5058}.sd-dashboard[data-sd-palette="light"] .sd-filter-row .sd-home-section-tab:hover,.sd-dashboard[data-sd-palette="light"] .sd-filter-row .sd-chip:hover{color:#1e1f22;background:#e3e5e8}.sd-dashboard[data-sd-palette="light"] .sd-filter-row .sd-home-section-tab.sd-active,.sd-dashboard[data-sd-palette="light"] .sd-filter-row .sd-chip.sd-active{color:#fff;background:#80848e}.sd-dashboard[data-sd-palette="light"] .sd-unread{background:#4e5058}.sd-dashboard[data-sd-palette="light"] .sd-preview-refresh,.sd-dashboard[data-sd-palette="light"] .sd-clear-history,.sd-dashboard[data-sd-palette="light"] .sd-chevron{color:#5c5e66}.sd-dashboard[data-sd-palette="light"] .sd-filter-separator{background:#c4c9ce}.sd-dashboard[data-sd-palette="light"] .sd-voice-avatars small{color:#5c5e66;border-color:#c4c9ce}
.sd-shell{display:block}.sd-sidebar{padding:8px;background:var(--sd-native-sidebar-bg,var(--background-base-lower,#121214));border-right:0}.sd-side-nav .sd-nav-home svg{width:22px;height:22px}
@media(max-width:900px){.sd-shell{grid-template-columns:190px minmax(0,1fr)}.sd-content{padding:25px 20px}.sd-brand strong{display:none}}
@media(max-width:700px){.sd-shell{grid-template-columns:1fr}.sd-sidebar{display:none}.sd-content{padding:20px 16px}.sd-toolbar{flex-direction:column}.sd-sort{height:42px}.sd-server-grid{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){.sd-home-button{transition:none}}
`; }
};
