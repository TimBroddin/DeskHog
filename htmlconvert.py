#!/usr/bin/env python3
print("DEBUG: htmlconvert.py is being loaded!")
import gzip
import os
import re

# Configuration
html_dir = "html"
html_file = f"{html_dir}/portal.html"  # The main HTML file
css_file = f"{html_dir}/portal.css"    # The CSS file
js_file = f"{html_dir}/portal.js"      # The JavaScript file
login_file = f"{html_dir}/login.js"    # The login maths, which the page script uses
output_dir = "include"                 # Output directory for header file
header_name = "html_portal.h"          # Name for the header file

def html_to_header():
    """Convert the HTML file to a C++ header file, inlining CSS and JS"""
    print("DEBUG: Starting html_to_header conversion")
    
    # Read HTML file
    try:
        with open(html_file, 'r', encoding='utf-8') as f:
            html_content = f.read()
        print(f"DEBUG: Successfully read {html_file}")
    except Exception as e:
        print(f"DEBUG: Error reading HTML file: {e}")
        return
    
    # Read CSS file
    try:
        with open(css_file, 'r', encoding='utf-8') as f:
            css_content = f.read()
        print(f"DEBUG: Successfully read {css_file}")
    except Exception as e:
        print(f"DEBUG: CSS file not found, skipping inline: {e}")
        css_content = None
    
    # Read JavaScript file
    try:
        with open(js_file, 'r', encoding='utf-8') as f:
            js_content = f.read()
        print(f"DEBUG: Successfully read {js_file}")
    except Exception as e:
        print(f"DEBUG: JS file not found, skipping inline: {e}")
        js_content = None
    
    # Read the login maths
    try:
        with open(login_file, 'r', encoding='utf-8') as f:
            login_content = f.read()
        print(f"DEBUG: Successfully read {login_file}")
    except Exception as e:
        print(f"DEBUG: Login file not found, skipping inline: {e}")
        login_content = None

    # Inline CSS if found
    if css_content:
        html_content = html_content.replace(
            '<link rel="stylesheet" href="portal.css">',
            f'<style>\n{css_content}\n</style>'
        )
    
    # Inline JavaScript if found
    if js_content:
        html_content = html_content.replace(
            '<script src="portal.js"></script>',
            f'<script>\n{js_content}\n</script>'
        )
    
    # The login maths, before the page script that uses it
    if login_content:
        html_content = html_content.replace(
            '<script src="login.js"></script>',
            f'<script>\n{login_content}\n</script>'
        )

    # Create output directory if it doesn't exist
    try:
        os.makedirs(output_dir, exist_ok=True)
        print(f"DEBUG: Ensured directory {output_dir} exists")
    except Exception as e:
        print(f"DEBUG: Error creating directory: {e}")
        return
    
    # The page is sent gzipped (Content-Encoding: gzip, see
    # CaptivePortal::handleRoot), at about a quarter of its size. mtime=0 keeps
    # the bytes, and so the committed header, the same from build to build.
    raw = html_content.encode('utf-8')
    packed = gzip.compress(raw, compresslevel=9, mtime=0)
    rows = [', '.join(f'0x{b:02x}' for b in packed[i:i + 16])
            for i in range(0, len(packed), 16)]
    body = ',\n    '.join(rows)

    # Create header content
    header_content = f"""// Generated file - do not edit!
// Source: {html_file}, with its CSS and scripts inlined, then gzipped.
// {len(raw)} bytes of page, {len(packed)} bytes gzipped.
#pragma once
#include <pgmspace.h>
static const uint8_t PORTAL_HTML_GZ[] PROGMEM = {{
    {body}
}};
"""
    
    # Write header file
    try:
        header_path = os.path.join(output_dir, header_name)
        with open(header_path, 'w', encoding='utf-8') as f:
            f.write(header_content)
        print(f"DEBUG: Successfully generated {header_path}")
        print(f"DEBUG: Final HTML size: {len(raw)} bytes, {len(packed)} gzipped")
        print(f"DEBUG: Generated header size: {os.path.getsize(header_path)} bytes")
    except Exception as e:
        print(f"DEBUG: Error writing header file: {e}")

# Run the conversion
print("DEBUG: About to convert HTML")
Import("env")
html_to_header()