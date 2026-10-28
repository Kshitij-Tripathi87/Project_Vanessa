import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from transcript_logging import format_transcript_log  # noqa: E402


class TranscriptLoggingTests(unittest.TestCase):
    def test_transcript_content_is_not_logged_by_default(self):
        spoken_content = "open my private budget spreadsheet"
        with patch.dict(os.environ, {"VANESSA_LOG_TRANSCRIPTS": "false"}):
            message = format_transcript_log("Partial transcript", spoken_content, "en")
        self.assertIn("characters=34", message)
        self.assertIn("language=en", message)
        self.assertNotIn(spoken_content, message)
        self.assertNotIn("private budget", message)

    def test_transcript_logging_requires_explicit_opt_in(self):
        spoken_content = "open my private budget spreadsheet"
        with patch.dict(os.environ, {}, clear=True):
            message = format_transcript_log("Final transcript", spoken_content, "en")
        self.assertNotIn(spoken_content, message)

    def test_opt_in_content_is_single_line_and_bounded(self):
        transcript = "hello\n" + ("x" * 700)
        message = format_transcript_log("Final transcript", transcript, "en", include_content=True)
        self.assertNotIn("\n", message)
        self.assertIn("…", message)
        self.assertLessEqual(len(message), 620)

    def test_language_and_event_fields_are_sanitized(self):
        message = format_transcript_log("Final\ntranscript", "hello", "en\nprivate", include_content=False)
        self.assertNotIn("\n", message)
        self.assertIn("Final transcript", message)
        self.assertIn("language=en private", message)


if __name__ == "__main__":
    unittest.main()
