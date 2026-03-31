import { SystemPlugin } from "../../src/plugins/types";
import { NotionTool } from "../../src/tools/NotionTool";

const plugin: SystemPlugin = {
  register(context) {
    context.toolRegistry.register(
      new NotionTool({
        apiKey: context.config.notion.apiKey,
        parentPageId: context.config.notion.parentPageId,
        dataSourceId: context.config.notion.dataSourceId,
        titleProperty: context.config.notion.titleProperty,
        version: context.config.notion.version
      })
    );
  }
};

export default plugin;
