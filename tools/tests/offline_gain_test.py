"""Cross-language offline-gain contract test.

The same vectors can be consumed by any implementation of the save system.
This test deliberately uses Decimal so Python does not introduce float overflow
or rounding differences while checking the shared contract.
"""

import json
import unittest
from decimal import Decimal
from pathlib import Path


VECTORS = Path(__file__).parents[2] / "src" / "game" / "data" / "offlineGainVectors.json"


class OfflineGainContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with VECTORS.open(encoding="utf-8") as stream:
            cls.document = json.load(stream)

    def test_vectors(self):
        efficiency = Decimal(self.document["efficiency"])
        maximum_ms = self.document["maxOfflineMs"]

        for case in self.document["cases"]:
            with self.subTest(case=case["name"]):
                elapsed_ms = max(0, min(case["elapsedMs"], maximum_ms))
                expected = {
                    key: Decimal(value)
                    for key, value in case["expected"].items()
                }
                actual = {}
                if case["elapsedMs"] > 0:
                    seconds = Decimal(elapsed_ms) / Decimal(1000)
                    for key, raw_rate in case["rates"].items():
                        rate = Decimal(raw_rate)
                        if rate > 0:
                            actual[key] = rate * seconds * efficiency
                self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
