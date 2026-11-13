# Third-party notices

| file | font | upstream | licence |
|---|---|---|---|
| `SymbolsNerdFontMono-Regular.woff2` | Symbols Nerd Font Mono 3.5.1 | https://github.com/ryanoasis/nerd-fonts (`NerdFontsSymbolsOnly.tar.xz`, release v3.5.1) | MIT — `LICENSE-nerd-fonts` |

The upstream file is `SymbolsNerdFontMono-Regular.ttf` (sha256 `fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749`),
converted to WOFF2 with fontTools without any other change. Its glyphs come
from the icon sets Nerd Fonts aggregates (Font Awesome, Devicons, Octicons,
Material Design Icons…), each redistributed upstream under a permissive licence.

The copyright line is repeated in a `/*! … */` comment of `globals.css`, which
CSS minification keeps, so the notice travels with the built stylesheet.
