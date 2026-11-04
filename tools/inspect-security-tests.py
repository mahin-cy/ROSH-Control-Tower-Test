import zipfile
import xml.etree.ElementTree as ET
import json

with zipfile.ZipFile('Security_Test_Suite_Core.xlsx') as z:
    shared_strings = []
    if 'xl/sharedStrings.xml' in z.namelist():
        tree = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in tree.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
            text = ''.join(t.text for t in si.iter('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t') if t.text)
            shared_strings.append(text)
    
    sheet = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    rows = []
    for r in sheet.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row'):
        row_vals = []
        for c in r.findall('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c'):
            t = c.get('t')
            v = c.find('{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v')
            val = v.text if v is not None else ''
            if t == 's' and val.isdigit():
                val = shared_strings[int(val)]
            row_vals.append(val)
        rows.append(row_vals)

header = rows[2]
test_cases = []
for r in rows[3:]:
    if not r or not r[0]: continue
    tc = dict(zip(header, r))
    test_cases.append(tc)

print(f"Total test cases loaded: {len(test_cases)}")
with open('tools/security-test-cases.json', 'w', encoding='utf-8') as f:
    json.dump(test_cases, f, indent=2)

for tc in test_cases:
    print(f"[{tc.get('Test Case ID')}] ({tc.get('Priority')}) {tc.get('Category')} -> {tc.get('Scenario')} | Status: {tc.get('Status')}")
