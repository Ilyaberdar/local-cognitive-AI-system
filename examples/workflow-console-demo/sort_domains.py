import re
import json

# Read the findings file
with open("research/findings.md", "r") as f:
    text = f.read()

# Extract full domain names using regex
domains = re.findall(r"example\.[com|net|org]", text)

# Deduplicate
deduped_domains = list(set(domains))

# Sort alphabetically
deduped_domains.sort()

# Write to JSON file
data = json.dumps(deduped_domains)
with open("sorted-domains.json", "w") as f:
    f.write(data + "\n")

# Print the sorted names
for domain in deduped_domains:
    print(domain)
