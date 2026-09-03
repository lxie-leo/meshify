"""语义化退出码 + 内核错误类型（与 core/src/exit-codes.ts 逐项对齐）。"""

EXIT_OK = 0
EXIT_INPUT_UNREADABLE = 2
EXIT_FORMAT_UNSUPPORTED = 3
EXIT_PARAM_CONFLICT = 4
EXIT_EXECUTOR_UNAVAILABLE = 5
EXIT_ALGORITHM_FAILED = 6
EXIT_RESOURCE_LIMIT = 7
EXIT_INTERNAL = 8


class KernelError(Exception):
    """携带语义化退出码的内核错误；runner 捕获后写进 manifest.errors 并按码退出。"""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


def input_unreadable(message: str) -> KernelError:
    return KernelError(EXIT_INPUT_UNREADABLE, message)


def param_conflict(message: str) -> KernelError:
    return KernelError(EXIT_PARAM_CONFLICT, message)


def algorithm_failed(message: str) -> KernelError:
    return KernelError(EXIT_ALGORITHM_FAILED, message)


def resource_limit(message: str) -> KernelError:
    return KernelError(EXIT_RESOURCE_LIMIT, message)
