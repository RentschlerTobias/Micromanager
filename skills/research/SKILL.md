---
name: research
description: Answer a research question from primary sources and cite every claim. Use when a jev-micromanager task asks you to research something, or a note starts with "[jev-micromanager] research for task".
license: MIT
metadata:
  source: https://github.com/mattpocock/skills/blob/24fe0ef7737efae15c87225755e9f6f5965e4888/skills/engineering/research/SKILL.md
  adapted: for a jev-micromanager worker, which reads itself instead of starting a background agent
---

# Research

You are one reader of a research task. Do the reading yourself; never start other agents.

1. Investigate the question against **primary sources**: official docs, source code, specs, first-party APIs, the
   paper itself. Not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Give the URL for every finding, the exact page, not the site's home page. A finding without a URL is left out.
3. Say what stayed unclear or where the sources disagree, with both URLs.
4. Change no files. If the brief says you are one of several readers, keep to your angle; the others cover the rest.
