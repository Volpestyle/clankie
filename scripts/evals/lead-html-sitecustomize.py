"""Trusted PYTHONPATH bootstrap in /opt/lead/bootstrap, never mounted in child."""
import importlib.abc
import sys


class NoCandidateParentImport(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "filter" or fullname.startswith("filter."):
            raise ImportError("Candidate modules execute only in the isolated child")
        return None


# The pinned tests only execute filter.py with subprocess.run(sys.executable,...).
# /app contains exactly that artifact; this also fences an accidental future import.
sys.meta_path.insert(0, NoCandidateParentImport())
sys.executable = "/opt/lead/candidate-python"
