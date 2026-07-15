from backend.core.pii_scrubber import scrub
import json

print("=== Testing PII Scrubber ===\n")

test_cases = [
    "Hi, my name is Ritish Nandikonda and my email is ritish@example.com",
    "Call me at +91 98765 43210 or 555-123-4567",
    # Real Luhn-valid test card numbers (VISA test range)
    "My credit card is 4532015112830366 and SSN is 219-09-9999",
    "I work at Google in Hyderabad",
    "I love chess",
]

for text in test_cases:
    print(f"IN:  {text}")
    result = scrub(text)
    print(f"OUT: {result['scrubbed_text']}")
    if result["pii_found"]:
        types = [p["type"] for p in result["pii_found"]]
        print(f"     Detected: {', '.join(types)}")
    print()

print("=== Done ===")