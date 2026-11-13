
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: FakeCliOptions

> **FakeCliOptions** = `object`

## Properties

### delayMs?

> `readonly` `optional` **delayMs?**: `number`

Wait this long between two lines, to exercise a stream that arrives slowly.

***

### dir

> `readonly` **dir**: `string`

Directory to create the executable in (yours; remove it after the test).

***

### exitCode?

> `readonly` `optional` **exitCode?**: `number`

Exit code once everything is printed. Default 0.

***

### lines

> `readonly` **lines**: readonly `string`[]

What the CLI prints on stdout, one line each, in order.

***

### name?

> `readonly` `optional` **name?**: `string`

File name without extension. Default `fake-cli`.

***

### stayUntilStdinCloses?

> `readonly` `optional` **stayUntilStdinCloses?**: `boolean`

Do not exit until stdin is closed (a persistent CLI). Default: exit after printing.

***

### stderr?

> `readonly` `optional` **stderr?**: `string`

Printed on stderr before the lines (a banner, a warning, a sign-in notice).
