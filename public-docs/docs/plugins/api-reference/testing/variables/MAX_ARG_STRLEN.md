
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Variable: MAX\_ARG\_STRLEN

> `const` **MAX\_ARG\_STRLEN**: `131072` = `131_072`

The longest single argument Linux accepts (32 pages): past it `execve` fails
 with E2BIG and the CLI never starts.
