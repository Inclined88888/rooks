#!/bin/bash

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

# Older packs linked /usr/bin/timon at the CLI. A final removal cleans only that
# link, and only when it still points at this package. A foreign timon stays.
if [ ! -e '/opt/${sanitizedProductName}/cli/timon' ] && [ "$(readlink /usr/bin/timon)" = '/opt/${sanitizedProductName}/cli/timon' ]; then
    rm -f /usr/bin/timon
fi
