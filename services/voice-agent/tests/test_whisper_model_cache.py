import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

from check_local_whisper_model import inspect_model_cache  # noqa: E402


class WhisperModelCacheTests(unittest.TestCase):
    def test_maps_common_model_size_to_faster_whisper_repository(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            for filename in ("config.json", "model.bin", "tokenizer.json"):
                (cache / filename).write_text("cached", encoding="utf-8")
            observed = []

            def lookup(repository, filename):
                observed.append((repository, filename))
                candidate = cache / filename
                return str(candidate) if candidate.is_file() else None

            ready, reason = inspect_model_cache("base", lookup)
            self.assertTrue(ready, reason)
            self.assertEqual({item[0] for item in observed}, {"Systran/faster-whisper-base"})
            self.assertIn(("Systran/faster-whisper-base", "model.bin"), observed)

    def test_preserves_explicit_hugging_face_repository_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            cache = Path(temporary)
            for filename in ("config.json", "model.bin", "vocabulary.txt"):
                (cache / filename).write_text("cached", encoding="utf-8")
            lookup = Mock(side_effect=lambda repository, filename: str(cache / filename) if (cache / filename).is_file() else None)
            ready, reason = inspect_model_cache("team/custom-whisper", lookup)
            self.assertTrue(ready, reason)
            self.assertEqual({call.args[0] for call in lookup.call_args_list}, {"team/custom-whisper"})

    def test_missing_model_is_reported_without_triggering_download(self):
        lookup = Mock(return_value=None)
        ready, reason = inspect_model_cache("base", lookup)
        self.assertFalse(ready)
        self.assertIn("not cached", reason)
        self.assertGreater(lookup.call_count, 0)

    def test_local_model_directory_requires_weights_config_and_tokenizer(self):
        with tempfile.TemporaryDirectory() as temporary:
            model_dir = Path(temporary)
            (model_dir / "config.json").write_text("{}", encoding="utf-8")
            (model_dir / "model.bin").write_bytes(b"weights")
            (model_dir / "tokenizer.json").write_text("{}", encoding="utf-8")
            ready, reason = inspect_model_cache(str(model_dir), Mock(side_effect=AssertionError("should not inspect hub cache")))
            self.assertTrue(ready, reason)

    def test_incomplete_local_directory_fails_without_network_lookup(self):
        with tempfile.TemporaryDirectory() as temporary:
            model_dir = Path(temporary)
            (model_dir / "config.json").write_text("{}", encoding="utf-8")
            lookup = Mock(side_effect=AssertionError("should not inspect hub cache"))
            ready, reason = inspect_model_cache(str(model_dir), lookup)
            self.assertFalse(ready)
            self.assertIn("missing required model files", reason)
            lookup.assert_not_called()

    def test_empty_and_missing_local_paths_fail_closed(self):
        ready, reason = inspect_model_cache("")
        self.assertFalse(ready)
        self.assertIn("empty", reason.lower())

        with tempfile.TemporaryDirectory() as temporary:
            ready, reason = inspect_model_cache(str(Path(temporary) / "vanessa-model-does-not-exist"))
            self.assertFalse(ready)
            self.assertIn("does not exist", reason)


if __name__ == "__main__":
    unittest.main()
