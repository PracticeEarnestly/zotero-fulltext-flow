import { FlowEngine } from "./core/FlowEngine";
import { AutoWatcher } from "./core/AutoWatcher";
import { Menus } from "./ui/Menus";
import { AuthManager } from "./core/AuthManager";

export class FullTextFlowAddon {
  data = { initialized: false };
  engine = new FlowEngine();
  watcher = new AutoWatcher(this.engine);
  menus = new Menus(this.engine);

  hooks = {
    onStartup: async () => {
      await Promise.all([Zotero.initializationPromise, Zotero.unlockPromise, Zotero.uiReadyPromise]);
      await AuthManager.initialize();
      for (const win of Zotero.getMainWindows()) this.menus.register(win);
      this.engine.start();
      this.watcher.start();
      this.data.initialized = true;
      Zotero.debug("FullTextFlow initialized");
    },
    onMainWindowLoad: async (win: any) => { this.menus.register(win); },
    onMainWindowUnload: async (win: any) => { this.menus.unregister(win); },
    onShutdown: async () => {
      this.engine.stop();
      this.watcher.stop();
      this.menus.unregisterAll();
      this.data.initialized = false;
      delete (Zotero as any).FullTextFlow;
    }
  };
}
