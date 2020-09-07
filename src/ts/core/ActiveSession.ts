import TabData from "./TabData.js";
import * as OptionsManager from "../options/OptionsManager.js";
import {
    Tab, Bookmark, Window,
    TabCreatedListener,
    TabRemoveListener,
    TabUpdatedListener,
    TabAttachedListener,
    TabDetachedListener,
    TabMovedListener,
    WindowRemovedListener
} from "../util/Types";
import { SessionContentUpdate } from "../messages/Messages.js";
import * as ActiveSessionManager from "./ActiveSessionManager.js";
import { createTab } from "../util/WebExtAPIHelpers.js";

type TabBookmark = [number, string];
const TAB_REMOVE_DELAY = 250;
const TAB_ERROR_PAGE_PREFIX = browser.runtime.getURL("html/tab-error.html");

export interface ActiveSessionData {
    readonly bookmarkId;
    readonly title:string;
    readonly windowId:number;
    readonly tabs:number[];
}

export default class ActiveSession {
    public readonly bookmarkId:string;
    private title:string;
    private windowId:number|null = null;
    
    // maps tab ids to bookmark ids
    private tabs:Map<number, string> = new Map();
    
    // removing tabs needs to be delayed because there is no API to detect window closing
    // https://bugzilla.mozilla.org/show_bug.cgi?id=1399885
    private bookmarkRemoveQueue:string[] = [];
    private removeTimeoutId:number = 0;

    // this is needed to avoid duplicate bookmarks for tabs activated via the sidebar
    private ignoreNextCreatedTab:boolean = false;

    // event listeners
    private tabAttachedListener:TabAttachedListener;
    private tabDetachedListener:TabDetachedListener;
    private tabCreatedListener:TabCreatedListener;
    private tabRemovedListener:TabRemoveListener;
    private tabUpdatedListener:TabUpdatedListener;
    private tabMovedListener:TabMovedListener;
    private wndRemovedListener:WindowRemovedListener;

    constructor(sessionBookmark:Bookmark) {
        this.bookmarkId = sessionBookmark.id;
        this.title = sessionBookmark.title;
    }

    /** Restores a session. If `tabBookmark` is set then only this single tab is restored. */
    private static async restore(sessionBookmark:Bookmark, tabBookmark?:Bookmark):Promise<ActiveSession> {
        // create ActiveSession instance
        let activeSession:ActiveSession = new ActiveSession(sessionBookmark);

        // load options
        const windowedSession:boolean = await OptionsManager.getValue("windowedSession");
        const discardTabs:boolean = await OptionsManager.getValue("lazyLoading");

        let indexOffset = 0;

        let emptyTab:Tab = null;
        if(windowedSession) {
            // windowed mode
            let wnd:Window = await activeSession.createSessionWindow();
            // new window contains a "newtab" tab
            emptyTab = wnd.tabs[0];
            // increment tab index by 1 to avoid the first tab rotating
            // to the end due to the empty tab being pinned
            indexOffset = 1;
        }

        // open a single tab or all tabs
        let tabsToOpen:Bookmark[] = tabBookmark ? [tabBookmark] : sessionBookmark.children;

        // add tabs
        await Promise.all(
            tabsToOpen.map(
                bookmark => activeSession.openBookmarkTab(bookmark, !discardTabs || tabBookmark !== undefined, false, indexOffset)
            )
        );

        // new window contains a "newtab" tab
        // -> close it after sessions tabs are restored
        if(emptyTab) {
            await browser.tabs.remove(emptyTab.id);
        }

        activeSession.setEventListeners();

        return activeSession;
    }

    /**
     * Creates an active session and restores all tabs.
     * @param sessionId - The bookmark id of the session to be restored
     */
    public static async restoreAll(sessionId:string):Promise<ActiveSession> {
        // get session bookmark & children
        let sessionBookmark:Bookmark = (await browser.bookmarks.getSubTree(sessionId))[0];
        console.assert(sessionBookmark && sessionBookmark.children.length > 0);

        return await ActiveSession.restore(sessionBookmark);
    }

    /**
     * Creates an active session but restores only a single tab.
     * @param tabBookmark - The bookmark of the tab to restore
     */
    public static async restoreSingleTab(tabBookmark:Bookmark):Promise<ActiveSession> {
        // parent bookmark = session bookmark
        let sessionId:string = tabBookmark.parentId;
        let sessionBookmark:Bookmark = (await browser.bookmarks.get(sessionId))[0];

        return await ActiveSession.restore(sessionBookmark, tabBookmark);
    }

    /**
     * Adds an existing tab to the active session.
     * If no bookmark id is passed as a second argument a new bookmark will be created.
     * If the session has its own window the tab will be moved to that window.
     * @param tab - A browser tab
     * @param tabBookmarkId - (Optional) The id of the bookmark representing this tab
     */
    public async addExistingTab(tab:Tab, tabBookmarkId?:string):Promise<void> {
        if(!tabBookmarkId) {
            // create a bookmark for this tab
            let tabBookmark:Bookmark = await browser.bookmarks.create(
                TabData.createFromTab(tab).getBookmarkCreateDetails(this.bookmarkId)
            );

            tabBookmarkId = tabBookmark.id;
        }

        // if tab is not part of the session window -> move it
        if(this.windowId && this.windowId !== tab.windowId) {
            console.assert(this.tabMovedListener === undefined);

            await browser.tabs.move(tab.id, {
                windowId: this.windowId,
                index: -1 // moves tab to the end of the window
            }).then(res => {
                if(res instanceof Array && res.length === 0) {
                    return Promise.reject("Tab " + tab.id + " could not be moved.");
                }
            });
        }

        // store session info via the sessions API
        await Promise.all([
            browser.sessions.setTabValue(tab.id, "sessionID", this.bookmarkId),
            browser.sessions.setTabValue(tab.id, "bookmarkID", tabBookmarkId)
        ]);

        this.tabs.set(tab.id, tabBookmarkId);
    }

    /**
     * Open a tab from a bookmark and add it to this session
     * @param tabBookmark - A bookmark from this session
     * @param makeActive (optional) Make this tab the active tab
     * @param skipCreateEvent (optional) Ignore the `tab created event` for this tab
     * @param offset (optional) Change the tab position (new index = old index + offset)
     */
    public async openBookmarkTab(tabBookmark:Bookmark, makeActive:boolean=false, skipCreateEvent:boolean = true, offset:number = 0):Promise<Tab> {
        console.assert(tabBookmark && tabBookmark.parentId === this.bookmarkId);

        let data:TabData = TabData.createFromBookmark(tabBookmark);
        let createProperties = data.getTabCreateProperties();

        if(makeActive) {
            createProperties.active = true;
            createProperties.discarded = false;
            createProperties.title = undefined;
        }

        if(this.windowId) {
            createProperties.windowId = this.windowId;
        }

        if(skipCreateEvent) {
            this.ignoreNextCreatedTab = true;
        }

        createProperties.index += offset;
        let browserTab:Tab = await createTab(createProperties);
        await this.addExistingTab(browserTab, tabBookmark.id);

        if(this.windowId) {
            // focus session window
            browser.windows.update(this.windowId, {
                focused: true
            });
        }

        return browserTab;
    }

    public async setTabAside(tabId:number):Promise<void> {
        if(this.tabs.delete(tabId)) {
            browser.tabs.remove(tabId);
        } else {
            return Promise.reject(new Error(`Tab ${tabId} is not part of this session.`));
        }
    }

    public async setTabsOrWindowAside():Promise<void> {
        this.removeEventListeners();

        if(this.tabs.size > 0) {
            if(this.windowId) {
                this.tabs = new Map();
                await browser.windows.remove(this.windowId);
            } else {
                let tabIds:number[] = this.getTabsIds();
                this.tabs = new Map();
                await browser.tabs.remove(tabIds);
                //TODO: prevent browser from closing
            }
        }
    }

    private async setAside() {
        return ActiveSessionManager.setAside(this.bookmarkId);
    }

    private async removeTabValues(tabId:number):Promise<void> {
        await Promise.all([
            browser.sessions.removeTabValue(tabId, "sessionID"),
            browser.sessions.removeTabValue(tabId, "bookmarkID")
        ]);
    }

    /**
     * Removes association from currently open tabs to this session.
     */
    public async free():Promise<void> {
        this.removeEventListeners();

        // do not remove window when setAside() gets called
        this.windowId = null;

        // remove session/tab values
        await Promise.all(
            Array.from(this.tabs.keys()).map(
                tabId => this.removeTabValues(tabId)
            )
        );

        this.tabs = new Map();
    }

    public hasTab(tabId:number):boolean {
        return this.tabs.has(tabId);
    }

    private getTabsIds():number[] {
        return Array.from(this.tabs.keys());
    }

    public getWindowId():number|null {
        return this.windowId;
    }

    public async createSessionWindow():Promise<Window> {
        if(this.windowId) {
            throw new Error("This session already has a window.");
        } else if(this.tabs.size > 0) {
            throw new Error("The window has to be set before tabs are added.");
        }

        const wnd:Window = await browser.windows.create();
        const emptyTab:Tab = wnd.tabs[0];

        // pin the empty tab to avoid problems when auto-moving pinned tabs to that window
        await browser.tabs.update(emptyTab.id, {pinned:true});

        await this.setWindow(wnd.id);
        return wnd;
    }

    public async setWindow(windowId:number):Promise<void> {
        if(this.windowId) {
            throw new Error("This session already has a window.");
        } else if(this.tabs.size > 0) {
            throw new Error("The window has to be set before tabs are added.");
        }

        this.windowId = windowId;
        await browser.sessions.setWindowValue(windowId, "sessionID", this.bookmarkId);

        const [bookmark] = await browser.bookmarks.get(this.bookmarkId);
        this.updateTitle(bookmark.title);
    }

    public static async reactivateWindow(sessionId:string, windowId:number):Promise<ActiveSession> {
        let bookmark:Bookmark = (await browser.bookmarks.get(sessionId))[0];
        let session:ActiveSession = new ActiveSession(bookmark);

        session.windowId = windowId;

        // load tabs
        let tabs:Tab[] = await browser.tabs.query({windowId:windowId});
        await Promise.all(tabs.map(async tab => {
            let tabBookmarkId = (await browser.sessions.getTabValue(tab.id, "bookmarkID")) as string;
            session.tabs.set(tab.id, tabBookmarkId);
        }));

        // restore window title
        session.updateTitle(bookmark.title);

        session.start();

        return session;
    }

    public static async reactivateTabs(sessionId:string, tabs:TabBookmark[]):Promise<ActiveSession> {
        let bookmark:Bookmark = (await browser.bookmarks.get(sessionId))[0];
        let session:ActiveSession = new ActiveSession(bookmark);

        tabs.forEach(x => session.tabs.set(x[0], x[1]));
        session.setEventListeners();

        return session;
    }

    public getData():ActiveSessionData {
        return {
            bookmarkId: this.bookmarkId,
            title: this.title,
            windowId: this.windowId,
            tabs: this.getTabsIds()
        };
    }

    public async hightlight():Promise<void> {
        let tabIds:number[] = this.getTabsIds();
        // the highlight API does not accept an empty array
        if(tabIds.length === 0) { return; }

        let tabs:Tab[] = await Promise.all(
            tabIds.map(
                tabId => browser.tabs.get(tabId)
            )
        );

        browser.tabs.highlight({
            tabs: tabs.map(tab => tab.index)
        }).catch(() => {
            console.log("[TA] Tab highlighting failed. This is most likely due to browser.tabs.multiselect not being enabled.");
        });
    }

    public start():void {
        if(this.tabCreatedListener) {
            throw new Error("Session is already active.");
        }

        // start tracking
        this.setEventListeners();
    }

    public updateTitle(title:string):void {
        this.title = title;

        if(this.windowId) {
            browser.windows.update(this.windowId, {
                titlePreface: title + " | "
            });
        }
    }

    private async removeBookmarksFromQueue() {
        this.removeTimeoutId = 0;

        let bookmarks = this.bookmarkRemoveQueue;
        // clear queue
        this.bookmarkRemoveQueue = [];

        // remove bookmarks
        await Promise.all(
            bookmarks.map(
                tabBookmarkId => browser.bookmarks.remove(tabBookmarkId)
            )
        );

        // check if the session should be removed
        let tabBookmarks:Bookmark[] = await browser.bookmarks.getChildren(this.bookmarkId);

        if(tabBookmarks.length === 0) {
            ActiveSessionManager.removeSession(this.bookmarkId);
        } else {
            // update sidebar
            SessionContentUpdate.send(this.bookmarkId);
        }
    }

    private async setEventListeners() {
        let removeTabs:boolean = (await OptionsManager.getValue<string>("tabClosingBehavior")) === "remove-tab";

        // removed tabs
        this.tabRemovedListener = async (tabId, removeInfo) => {
            let tabBookmarkId:string = this.tabs.get(tabId);

            // check if tab is part of this session
            if(tabBookmarkId) {
                // remove tab
                this.tabs.delete(tabId);

                if(removeTabs) {
                    if(this.removeTimeoutId > 0) {
                        window.clearTimeout(this.removeTimeoutId);
                    }
    
                    // only remove tab from bookmarks after a timeout
                    // to prevent the session from being removed when the window is closed
                    // the delay may be removed when https://bugzilla.mozilla.org/show_bug.cgi?id=1399885 gets shipped
                    this.bookmarkRemoveQueue.push(tabBookmarkId);
                    this.removeTimeoutId = window.setTimeout(
                        () => this.removeBookmarksFromQueue(),
                        TAB_REMOVE_DELAY
                    );
                }
            }
        };

        this.tabDetachedListener = async (tabId, removeInfo) => {
            let tabBookmarkId:string = this.tabs.get(tabId);

            // check if tab is part of this session
            if(tabBookmarkId) {
                // remove tab
                this.tabs.delete(tabId);

                // tab still exists -> remove tab values
                await this.removeTabValues(tabId);

                // remove associated bookmark
                await browser.bookmarks.remove(tabBookmarkId);

                // update sidebar
                SessionContentUpdate.send(this.bookmarkId);

                if(this.tabs.size === 0) {
                    let tabBookmarks:Bookmark[] = await browser.bookmarks.getChildren(this.bookmarkId);

                    if(tabBookmarks.length === 0) {
                        ActiveSessionManager.removeSession(this.bookmarkId);
                        return;
                    } else {
                        ActiveSessionManager.setAside(this.bookmarkId);
                    }
                }
            }
        };

        // added tabs
        this.tabAttachedListener = async (tabId, attachInfo) => {
            if(attachInfo.newWindowId === this.windowId) {
                let tab:Tab = await browser.tabs.get(tabId);
                await this.addExistingTab(tab);

                // update sidebar
                SessionContentUpdate.send(this.bookmarkId);
            }
        };

        this.tabCreatedListener = async (tab) => {
            if(this.ignoreNextCreatedTab && tab.windowId === this.windowId) {
                this.ignoreNextCreatedTab = false;
                console.log("[TA] tab ignored", tab);
                return;
            }

            /* determine if tab should be added to the session
             * the tab should be added if:
             * - tab is part of the sessions window (windowed mode)
             * - tab was opened by/from a tab from this session
            */
            let addToSession:boolean = tab.windowId === this.windowId
                || (tab.hasOwnProperty("openerTabId") && this.tabs.has(tab.openerTabId));

            if(addToSession) {
                await this.addExistingTab(tab);

                // update sidebar
                SessionContentUpdate.send(this.bookmarkId);
            }
        };

        // modified tabs
        this.tabUpdatedListener = async (tabId, changeInfo, tab) => {
            let tabBookmarkId:string = this.tabs.get(tabId);

            // check if tab is part of this session
            if(tabBookmarkId) {
                if(tab.url === "about:blank") {
                    // (discarded) loading tabs cycle through a phase where they are about:blank
                    return;
                } else if(tab.url.startsWith(TAB_ERROR_PAGE_PREFIX)) {
                    // do not store tab error URL, keep the URL that could not be restored
                    return;
                }

                // only update session for certain changes
                let update:boolean = tab.status === "complete"
                    || changeInfo.hasOwnProperty("url")
                    || changeInfo.hasOwnProperty("title")
                    || changeInfo.hasOwnProperty("mutedInfo")
                    || changeInfo.hasOwnProperty("pinned");

                if(update) {
                    // update this Tabs bookmark
                    await browser.bookmarks.update(
                        tabBookmarkId,
                        TabData.createFromTab(tab).getBookmarkUpdate()
                    );

                    // update sidebar
                    SessionContentUpdate.send(this.bookmarkId);
                }
            }
        };

        this.tabMovedListener = async (tabId, moveInfo) => {
            let tabBookmarkId:string = this.tabs.get(tabId);

            // check if tab is part of this session
            if(tabBookmarkId) {
                await browser.bookmarks.move(tabBookmarkId, { index: moveInfo.toIndex });

                // update sidebar
                SessionContentUpdate.send(this.bookmarkId);
            }
        };

        this.wndRemovedListener = async (windowId) => {
            if(this.windowId === windowId && this.bookmarkRemoveQueue.length > 1) {
                console.assert(this.removeTimeoutId > 0);

                // do not remove tabs, ...
                window.clearTimeout(this.removeTimeoutId);
                console.log("[TA] Prevented removal of session & tab bookmarks.");

                // ... just set the session aside
                this.setAside();
            }
        };

        // add event listeners
        browser.tabs.onCreated.addListener(this.tabCreatedListener);
        browser.tabs.onRemoved.addListener(this.tabRemovedListener);
        browser.tabs.onUpdated.addListener(this.tabUpdatedListener);

        if(this.windowId) {
            browser.tabs.onAttached.addListener(this.tabAttachedListener);
            browser.tabs.onDetached.addListener(this.tabDetachedListener);
            browser.tabs.onMoved.addListener(this.tabMovedListener);
            browser.windows.onRemoved.addListener(this.wndRemovedListener);
        }
    }

    private removeEventListeners() {
        browser.tabs.onCreated.removeListener(this.tabCreatedListener);
        browser.tabs.onRemoved.removeListener(this.tabRemovedListener);
        browser.tabs.onUpdated.removeListener(this.tabUpdatedListener);

        if(browser.tabs.onAttached.hasListener(this.tabAttachedListener)) {
            browser.tabs.onAttached.removeListener(this.tabAttachedListener);
            browser.tabs.onDetached.removeListener(this.tabDetachedListener);
            browser.tabs.onMoved.removeListener(this.tabMovedListener);
            browser.windows.onRemoved.removeListener(this.wndRemovedListener);
        }
    }
}
