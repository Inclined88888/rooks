
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: DictationLanguages

> **DictationLanguages** = `object`

Languages a dictation engine recognises (client API 14). `codes` are BCP 47
primary subtags (`fr`, `en`). `auto`: the engine detects the language and
may ignore the one it is given; `forced`: it uses the one it is given, or
detects without; `required`: it cannot start without one.

## Properties

### codes

> `readonly` **codes**: readonly `string`[]

***

### mode

> `readonly` **mode**: `"auto"` \| `"forced"` \| `"required"`
