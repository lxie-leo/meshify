"""``python -m meshify_kernel <payload.json>`` 入口。"""

from __future__ import annotations

import sys

from .runner import main

if __name__ == "__main__":
    sys.exit(main(sys.argv))
