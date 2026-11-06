#!/bin/bash

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# The CLI link stays out of update-alternatives on purpose: `--install` would
# silently replace a foreign /usr/bin/timon symlink (a source checkout's
# `npm link`), and an unconditional `--remove` here also runs on upgrade,
# after the new package's post-install on rpm. Only one package provides
# `timon`, so there is nothing to arbitrate.
# A replacement package keeps its launcher; a final removal cleans only our link.
if [ ! -e '/opt/${sanitizedProductName}/cli/timon' ] && [ "$(readlink /usr/bin/timon)" = '/opt/${sanitizedProductName}/cli/timon' ]; then
    rm -f /usr/bin/timon
fi
