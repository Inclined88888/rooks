import {Converter} from 'typedoc';
/** Internal source comments are not public documentation. Only SDK-owned English TSDoc is retained. */
export function load(app) {
  app.converter.on(Converter.EVENT_RESOLVE_END, context => {
    for (const reflection of Object.values(context.project.reflections)) {
      const owned = reflection.sources?.some(source => source.fullFileName?.includes('/packages/sdk/'));
      // The project's own comment is the entry point's @packageDocumentation, written in the SDK.
      if (!owned && !reflection.isProject()) reflection.comment = undefined;
      reflection.sources = undefined;
    }
  });
}
