import { FlowEngine } from "./core/FlowEngine";
import { AutoWatcher } from "./core/AutoWatcher";
import { PubMedWatcher } from "./core/PubMedWatcher";
import { Menus } from "./ui/Menus";
import { PubMedMenus } from "./ui/PubMedMenus";
import { AuthManager } from "./core/AuthManager";

export class FullTextFlowAddon {
  data = { initialized: false };
  engine = new FlowEngine();
  watcher = new AutoWatcher(this.engine);
  pubmedWatcher = new PubMedWatcher();
  menus = new Menus(this.engine);
  pubmedMenus = new PubMedMenus();

  hooks = {
    onStartup: async () => {
      await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
      await AuthManager.initialize();
      for (const win of Zotero.getMainWindows()) {
        this.menus.register(win);
        this.pubmedMenus.register(win);
      }
      this.engine.start();
      this.watcher.start();
      this.pubmedWatcher.start();
      this.data.initialized = true;
      Zotero.debug("FullTextFlow initialized");
    },
    onMainWindowLoad: async (win: any) => {
      this.menus.register(win);
      this.pubmedMenus.register(win);
    },
    onMainWindowUnload: async (win: any) => {
      this.menus.unregister(win);
      this.pubmedMenus.unregister(win);
    },
    onShutdown: async () => {
      this.engine.stop();
      this.watcher.stop();
      this.pubmedWatcher.stop();
      this.menus.unregisterAll();
      this.pubmedMenus.unregisterAll();
      this.data.initialized = false;
      delete (Zotero as any).FullTextFlow;
    }
  };
}
