#!/usr/bin/env python3
"""
Phase 1.1: Router Evaluation Harness

Tests LLM function calling accuracy against the eval test set.
Supports multiple backends: Ollama, OpenAI API, or mock for testing.
"""

import json
import time
import sys
from pathlib import Path
from typing import Dict, List, Optional, Any
from dataclasses import dataclass
from tool_schemas import TOOL_SCHEMAS, get_openai_format_tools


@dataclass
class TestCase:
    """Single test case from eval set"""
    id: str
    lang: str
    utterance: str
    expect: Dict[str, Any]
    flags: List[str]


@dataclass
class TestResult:
    """Result of testing one case"""
    case_id: str
    lang: str
    utterance: str
    expected_tool: str
    expected_args: Dict[str, Any]
    actual_tool: Optional[str]
    actual_args: Optional[Dict[str, Any]]
    correct: bool
    error: Optional[str]
    latency_ms: int
    flags: List[str]


class RouterEvaluator:
    """Evaluates router performance on test cases"""

    def __init__(self, backend: str = "mock"):
        """
        Initialize evaluator

        Args:
            backend: "ollama", "openai", or "mock"
        """
        self.backend = backend
        self.tools = get_openai_format_tools()

    def load_test_cases(self, jsonl_path: str) -> List[TestCase]:
        """Load test cases from JSONL file"""
        cases = []
        with open(jsonl_path, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    data = json.loads(line)
                    cases.append(TestCase(
                        id=data['id'],
                        lang=data['lang'],
                        utterance=data['utterance'],
                        expect=data['expect'],
                        flags=data.get('flags', [])
                    ))
        return cases

    def call_model(self, utterance: str, lang: str) -> tuple[Optional[str], Optional[Dict], int]:
        """
        Call the LLM to get tool selection

        Returns:
            (tool_name, arguments, latency_ms)
        """
        start = time.time()

        if self.backend == "mock":
            # Mock implementation for testing the harness
            tool_name, args = self._mock_router(utterance, lang)
        elif self.backend == "ollama":
            tool_name, args = self._call_ollama(utterance, lang)
        elif self.backend == "openai":
            tool_name, args = self._call_openai(utterance, lang)
        else:
            raise ValueError(f"Unknown backend: {self.backend}")

        latency_ms = int((time.time() - start) * 1000)
        return tool_name, args, latency_ms

    def _mock_router(self, utterance: str, lang: str) -> tuple[Optional[str], Optional[Dict]]:
        """Mock router for testing (always returns escalate)"""
        return "escalate", {"reason": "mock"}

    def _call_ollama(self, utterance: str, lang: str) -> tuple[Optional[str], Optional[Dict]]:
        """Call Ollama with function calling"""
        try:
            import requests

            # Ollama API endpoint
            url = "http://localhost:11434/api/chat"

            payload = {
                "model": "lfm3:latest",
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a voice assistant router. Call the appropriate tool for the user's request."
                    },
                    {
                        "role": "user",
                        "content": utterance
                    }
                ],
                "tools": self.tools,
                "stream": False
            }

            response = requests.post(url, json=payload, timeout=30)
            response.raise_for_status()

            data = response.json()

            # Extract tool call from response
            message = data.get("message", {})
            tool_calls = message.get("tool_calls", [])

            if tool_calls:
                tool_call = tool_calls[0]
                function = tool_call.get("function", {})
                return function.get("name"), function.get("arguments", {})

            return None, None

        except Exception as e:
            print(f"Ollama error: {e}", file=sys.stderr)
            return None, None

    def _call_openai(self, utterance: str, lang: str) -> tuple[Optional[str], Optional[Dict]]:
        """Call OpenAI API with function calling"""
        try:
            import openai

            client = openai.OpenAI()

            response = client.chat.completions.create(
                model="gpt-4-turbo-preview",
                messages=[
                    {
                        "role": "system",
                        "content": "You are a voice assistant router. Call the appropriate tool for the user's request."
                    },
                    {
                        "role": "user",
                        "content": utterance
                    }
                ],
                tools=self.tools,
                tool_choice="auto"
            )

            message = response.choices[0].message

            if message.tool_calls:
                tool_call = message.tool_calls[0]
                return tool_call.function.name, json.loads(tool_call.function.arguments)

            return None, None

        except Exception as e:
            print(f"OpenAI error: {e}", file=sys.stderr)
            return None, None

    def check_match(self, expected: Dict, actual_tool: Optional[str], actual_args: Optional[Dict]) -> bool:
        """Check if actual matches expected"""
        if actual_tool is None:
            return False

        expected_tool = expected.get('t')
        expected_args = expected.get('a', {})

        # Tool name must match
        if actual_tool != expected_tool:
            return False

        # Check all expected arguments are present and match
        if actual_args is None:
            actual_args = {}

        for key, value in expected_args.items():
            if key not in actual_args:
                return False
            if actual_args[key] != value:
                return False

        return True

    def evaluate_case(self, case: TestCase) -> TestResult:
        """Evaluate a single test case"""
        actual_tool, actual_args, latency_ms = self.call_model(case.utterance, case.lang)

        expected_tool = case.expect.get('t')
        expected_args = case.expect.get('a', {})

        correct = self.check_match(case.expect, actual_tool, actual_args)

        return TestResult(
            case_id=case.id,
            lang=case.lang,
            utterance=case.utterance,
            expected_tool=expected_tool,
            expected_args=expected_args,
            actual_tool=actual_tool,
            actual_args=actual_args,
            correct=correct,
            error=None if actual_tool else "No tool called",
            latency_ms=latency_ms,
            flags=case.flags
        )

    def evaluate_all(self, test_cases: List[TestCase]) -> List[TestResult]:
        """Evaluate all test cases"""
        results = []

        for i, case in enumerate(test_cases):
            print(f"[{i+1}/{len(test_cases)}] Testing {case.id} ({case.lang}): {case.utterance[:50]}...")
            result = self.evaluate_case(case)
            results.append(result)

            if not result.correct:
                print(f"  ❌ Expected {result.expected_tool}, got {result.actual_tool}")

        return results

    def print_summary(self, results: List[TestResult]):
        """Print evaluation summary"""
        total = len(results)
        correct = sum(1 for r in results if r.correct)

        # By language
        by_lang = {}
        for r in results:
            if r.lang not in by_lang:
                by_lang[r.lang] = {'correct': 0, 'total': 0}
            by_lang[r.lang]['total'] += 1
            if r.correct:
                by_lang[r.lang]['correct'] += 1

        # Latency stats
        latencies = [r.latency_ms for r in results]
        latencies.sort()
        p50 = latencies[len(latencies) // 2]
        p95 = latencies[int(len(latencies) * 0.95)]

        # Critical failures (T2 or UNSAFE)
        critical_failures = [r for r in results if not r.correct and ('T2' in r.flags or 'UNSAFE' in r.flags)]

        print("\n" + "="*60)
        print("EVALUATION SUMMARY")
        print("="*60)
        print(f"Overall Accuracy: {correct}/{total} ({correct/total*100:.1f}%)")
        print()
        print("By Language:")
        for lang, stats in sorted(by_lang.items()):
            acc = stats['correct'] / stats['total'] * 100
            print(f"  {lang:10s}: {stats['correct']:3d}/{stats['total']:3d} ({acc:5.1f}%)")
        print()
        print("Latency:")
        print(f"  p50: {p50}ms")
        print(f"  p95: {p95}ms")
        print()
        print(f"Critical Failures (T2/UNSAFE): {len(critical_failures)}")
        if critical_failures:
            for r in critical_failures[:5]:
                print(f"  - {r.case_id}: {r.utterance[:60]}")
        print("="*60)

    def save_results(self, results: List[TestResult], output_path: str):
        """Save detailed results to JSON"""
        data = {
            'timestamp': time.time(),
            'backend': self.backend,
            'total_cases': len(results),
            'correct': sum(1 for r in results if r.correct),
            'results': [
                {
                    'id': r.case_id,
                    'lang': r.lang,
                    'utterance': r.utterance,
                    'expected': {
                        'tool': r.expected_tool,
                        'args': r.expected_args
                    },
                    'actual': {
                        'tool': r.actual_tool,
                        'args': r.actual_args
                    },
                    'correct': r.correct,
                    'latency_ms': r.latency_ms,
                    'flags': r.flags
                }
                for r in results
            ]
        }

        with open(output_path, 'w') as f:
            json.dump(data, f, indent=2)

        print(f"\nDetailed results saved to: {output_path}")


def main():
    """Main entry point"""
    import argparse

    parser = argparse.ArgumentParser(description='Evaluate router model on test cases')
    parser.add_argument('--backend', choices=['mock', 'ollama', 'openai'], default='mock',
                        help='Backend to use for inference')
    parser.add_argument('--input', default='eval/router-v1.jsonl',
                        help='Path to test cases (JSONL)')
    parser.add_argument('--output', default='eval/results.json',
                        help='Path to save results (JSON)')
    parser.add_argument('--limit', type=int, default=None,
                        help='Limit number of test cases')

    args = parser.parse_args()

    # Initialize evaluator
    evaluator = RouterEvaluator(backend=args.backend)

    # Load test cases
    print(f"Loading test cases from: {args.input}")
    test_cases = evaluator.load_test_cases(args.input)

    if args.limit:
        test_cases = test_cases[:args.limit]

    print(f"Loaded {len(test_cases)} test cases")
    print()

    # Run evaluation
    results = evaluator.evaluate_all(test_cases)

    # Print summary
    evaluator.print_summary(results)

    # Save results
    evaluator.save_results(results, args.output)


if __name__ == '__main__':
    main()
