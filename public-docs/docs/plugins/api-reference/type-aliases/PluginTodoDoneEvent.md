
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: PluginTodoDoneEvent

> **PluginTodoDoneEvent** = `Readonly`\<\{ `kind`: `"todo_done"`; `origin`: [`PluginTodoOrigin`](PluginTodoOrigin.md); `previousProgress`: `string` \| `null`; `todo`: `Readonly`\<\{ `done_at`: `number` \| `null`; `id`: `number`; `links`: readonly [`PluginTodoEventLink`](PluginTodoEventLink.md)[]; `owner_user_id`: `string` \| `null`; `progress`: `string` \| `null`; `project`: `string` \| `null`; `text`: `string`; `urgency`: `string` \| `null`; \}\>; `todoId`: `number`; \}\>
