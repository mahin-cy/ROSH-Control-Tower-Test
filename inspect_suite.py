import json

with open("test_cases_dump.json", "r", encoding="utf-8") as f:
    cases = json.load(f)

for c in cases:
    cid = c.get('Test Case ID')
    if cid in ['AUTHZ-01', 'AUTHZ-02', 'AUTHZ-03', 'MQTT-01', 'MQTT-02', 'MQTT-03', 'MQTT-04', 'VID-01', 'VID-02', 'VID-03', 'API-01']:
        print("=" * 60)
        print(f"{cid} [{c.get('Priority')}] : {c.get('Scenario')}")
        print(f"Category: {c.get('Category')} | Component: {c.get('Component')}")
        print(f"Objective: {c.get('Objective / Risk')}")
        print(f"Preconditions: {c.get('Preconditions')}")
        print(f"Test Steps:\n{c.get('Test Steps')}")
        print(f"Expected Result:\n{c.get('Expected Result')}")

