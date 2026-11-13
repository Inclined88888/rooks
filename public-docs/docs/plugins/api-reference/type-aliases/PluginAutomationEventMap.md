
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginAutomationEventMap

> **PluginAutomationEventMap** = `{ [K in PluginAutomationEventKind]: PluginAutomationEvent extends infer E ? E extends { kind: infer Kd } ? K extends Kd ? E : never : never : never }`
