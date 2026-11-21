"""
Stores the recipes quests can need, so /api/quest_prices doesn't look them up on BitJita each time.

Local tool, not deployed. Run from the repo root when recipes or quests change (after a game patch):

    python tools/build_quest_recipes.py                 # recipes from ../Bitcraft Effort/data/recipes.json
    python tools/build_quest_recipes.py --effort-dir PATH

Walks every item any quest stage asks for, then the ingredients of the recipe used to craft each one,
CRAFT_DEPTH levels down (the same recipe and depth /api/quest_prices follows), and writes
api/quest_recipes.json: {"recipes": {"item:ID" | "cargo:ID": {"craftingRecipes": [recipe]}}}.
Items with no recipe are stored too (an empty list), so the price lookup knows not to ask BitJita.

Item recipes come from the Bitcraft Effort project's game data (its GitHub job refreshes it every 6 hours,
so "git pull" there first), with station names from BitJita's building list. Only what that data doesn't
cover (cargo) is looked up on BitJita, one item at a time.
"""

import argparse
import json
import os
import sys
import time
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'api'))

from _lib import api_get                                                                  # noqa: E402
from quest_prices import CRAFT_DEPTH, detail_path, pick_recipe, slim_recipe               # noqa: E402

OUT        = os.path.join(ROOT, 'api', 'quest_recipes.json')
EFFORT_DIR = os.path.join(ROOT, '..', 'Bitcraft Effort')

SKILL_NAMES = {
    1: 'ANY', 2: 'Forestry', 3: 'Carpentry', 4: 'Masonry', 5: 'Mining', 6: 'Smithing', 7: 'Scholar',
    8: 'Leatherworking', 9: 'Hunting', 10: 'Tailoring', 11: 'Farming', 12: 'Fishing', 13: 'Cooking',
    14: 'Foraging', 15: 'Construction', 17: 'Taming', 18: 'Slayer', 19: 'Merchanting', 21: 'Sailing',
}


def quest_items():
    """(id, type) of every item any quest stage asks for."""
    first  = api_get('/api/quests', {'limit': 100, 'page': 1})
    quests = list(first.get('quests', []))
    for page in range(2, (first.get('totalPages') or 1) + 1):
        quests += api_get('/api/quests', {'limit': 100, 'page': page}).get('quests', [])
    keys = set()
    for q in quests:
        for stage in q.get('stageDetails') or []:
            for c in stage.get('completionConditions') or []:
                if c.get('type') == 'ItemStack' and str(c.get('item_id')) != '1':   # Hex Coin isn't crafted
                    keys.add((str(c.get('item_id')), 'cargo' if str(c.get('item_type', '')).lower() == 'cargo' else 'item'))
    return len(quests), keys


def station_names():
    """{(building type, tier): name}: the station a recipe needs, by its building requirement. The plain
    station of that tier is preferred over an Ancient one or a higher tier."""
    found = defaultdict(list)   # building type -> [(level, ancient, name)]
    for b in api_get('/api/buildings'):
        for f in b.get('functions') or []:
            if f.get('crafting_slots') or f.get('refining_slots'):
                found[f.get('function_type')].append((f.get('level') or 0, b.get('name', '').startswith('Ancient'), b.get('name', '')))
    return found


def station(found, btype, tier):
    fits = sorted(s for s in found.get(btype, []) if s[0] >= (tier or 0))
    return fits[0][2] if fits else ''


def effort_detail(entry, item_name, found):
    """A Bitcraft Effort recipes.json entry in the shape BitJita's item details use."""
    recipes = []
    for r in entry.get('crafting') or []:
        r = dict(r)
        r['name'] = (r.get('name') or '').replace('{0}', item_name)
        r['buildingName'] = station(found, r.get('buildingType') or r.get('buildingRequirementType'),
                                    r.get('buildingTier') or r.get('buildingRequirementTier'))
        r['levelRequirements'] = [{**l, 'skill': {'name': SKILL_NAMES.get(l.get('skill_id'), f"Skill {l.get('skill_id')}")}}
                                  for l in r.get('levelRequirements') or []]
        recipes.append(r)
    return {'craftingRecipes': recipes}


def bitjita_detail(key, tries=5):
    """An item's details from BitJita, which turns away bursts, so wait and retry."""
    for n in range(tries):
        try:
            return api_get(detail_path(key))
        except Exception:
            time.sleep(2 ** n)
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--effort-dir', default=EFFORT_DIR, help='the Bitcraft Effort project (default: next to this one)')
    args = ap.parse_args()

    path = os.path.join(args.effort_dir, 'data', 'recipes.json')
    if not os.path.exists(path):
        raise SystemExit(f'Bitcraft Effort recipe data not found at {os.path.abspath(path)}; pass --effort-dir')
    age_days = (time.time() - os.path.getmtime(path)) / 86400
    if age_days > 2:
        print(f'warning: the Bitcraft Effort recipe data is {age_days:.0f} days old; '
              f'run "git pull" in {os.path.abspath(args.effort_dir)} for the latest')
    with open(path, encoding='utf-8') as f:
        effort = json.load(f)

    started = time.time()
    count, level = quest_items()
    found = station_names()
    print(f'{count} quests ask for {len(level)} items')
    recipes, failed, asked = {}, [], 0
    for depth in range(CRAFT_DEPTH + 1):   # the quest items, then CRAFT_DEPTH levels of ingredients
        todo = sorted(k for k in level if f'{k[1]}:{k[0]}' not in recipes)
        if not todo:
            break
        nxt = set()
        for k in todo:
            entry = effort.get(k[0]) if k[1] == 'item' else None
            if entry is not None:
                d = effort_detail(entry, entry.get('name') or k[0], found)
            else:
                d = bitjita_detail(k)
                asked += 1
            if d is None:
                failed.append(k)
                continue
            recipes[f'{k[1]}:{k[0]}'] = {'craftingRecipes': [slim_recipe(r) for r in d.get('craftingRecipes') or []
                                                             if r.get('consumedItems')]}
            r = pick_recipe(d)
            if r and depth < CRAFT_DEPTH:
                nxt |= {(str(c.get('id')), 'cargo' if c.get('itemType') == 1 else 'item') for c in r['consumedItems']}
        print(f'  level {depth}: {len(todo)} items, {len(nxt)} ingredients to follow')
        level = nxt
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump({'built': time.strftime('%Y-%m-%d'), 'depth': CRAFT_DEPTH, 'recipes': recipes}, f,
                  separators=(',', ':'), sort_keys=True)
    print(f'Wrote {len(recipes)} items to {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT) // 1024} KB) '
          f'in {time.time() - started:.0f}s ({asked} looked up on BitJita)')
    if failed:
        print(f'{len(failed)} lookups failed (the price lookup asks BitJita for those): {failed[:10]}')


if __name__ == '__main__':
    main()
