"""Abstract base class for file readers."""

from abc import ABC, abstractmethod
from .models import Recording


class BaseReader(ABC):
    """Interface that all file format readers must implement."""

    @staticmethod
    @abstractmethod
    def can_read(file_path: str) -> bool:
        """Return True if this reader can handle the given file."""
        ...

    @abstractmethod
    def read(self, file_path: str) -> Recording:
        """Read the file and return a Recording object."""
        ...
