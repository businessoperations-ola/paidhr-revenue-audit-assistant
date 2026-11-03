"""Regenerate src/web/brand/logos.ts from the logo PNGs next to it.

Run after replacing paidhr-logo-blue.png (for light backgrounds) or
paidhr-logo-white.png (for the blue sign-in screen) with official files:
    python3 scripts/embed-brand.py
"""
import base64
from pathlib import Path

brand = Path(__file__).resolve().parent.parent / 'src' / 'web' / 'brand'
blue = base64.b64encode((brand / 'paidhr-logo-blue.png').read_bytes()).decode()
white = base64.b64encode((brand / 'paidhr-logo-white.png').read_bytes()).decode()
(brand / 'logos.ts').write_text(f'''/**
 * PaidHR logo, cut from screenshots of paidhr.com with a transparent background.
 * Generated from paidhr-logo-blue.png and paidhr-logo-white.png in this folder
 * (scripts/embed-brand.py). Replace those PNGs with the official logo files and
 * re-run the script to update.
 */
export const LOGO_BLUE_PNG = Buffer.from('{blue}', 'base64');
export const LOGO_WHITE_PNG = Buffer.from('{white}', 'base64');
export const LOGO_BLUE_DATA_URI = 'data:image/png;base64,{blue}';
export const LOGO_WHITE_DATA_URI = 'data:image/png;base64,{white}';
''')
print('Updated', brand / 'logos.ts')
