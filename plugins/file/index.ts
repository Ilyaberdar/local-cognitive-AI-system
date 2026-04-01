import { FileTool } from "../../src/tools/FileTool";
import { SystemPlugin } from "../../src/plugins/types";

const plugin: SystemPlugin = {
  register(context) {
    context.toolRegistry.register(
      new FileTool({
        outputDir: context.config.outputDir,
        accessMode: context.config.filesystem.accessMode,
        allowedDirectories: context.config.filesystem.allowedDirectories
      })
    );
  }
};

export default plugin;
