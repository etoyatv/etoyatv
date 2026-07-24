import os
import re
import json
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading

# Directories and Files
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VIEWS_DIR = os.path.join(SCRIPT_DIR, '../app/views')
ROUTES_DIR = os.path.join(SCRIPT_DIR, '../app/routes')
SERVER_FILE = os.path.join(SCRIPT_DIR, '../app/server.js')
PUBLIC_JS_DIR = os.path.join(SCRIPT_DIR, '../public/js')
LOCALES_DIR = os.path.join(SCRIPT_DIR, '../locales')

TARGET_LANGS = ['ru', 'en', 'uk', 'be']
# Dynamically add any other JSON files found in the locales directory
if os.path.exists(LOCALES_DIR):
    try:
        for f in os.listdir(LOCALES_DIR):
            if f.endswith('.json'):
                lang = f[:-5]
                if lang not in TARGET_LANGS:
                    TARGET_LANGS.append(lang)
    except Exception as e:
        print(f"Failed to read locales directory dynamically: {e}")
cache_lock = threading.Lock()

def get_files_recursive(dir_path, extension):
    results = []
    for root, _, files in os.walk(dir_path):
        for file in files:
            if file.endswith(extension):
                results.append(os.path.join(root, file))
    return results

def has_cyrillic(text):
    return bool(re.search(r'[\u0400-\u04FF]', text))

def normalize_text(text):
    if not text:
        return ""
    text = text.strip()
    text = re.sub(r'\s+', ' ', text)
    return text

def extract_cyrillic_phrases(content):
    # Fast, linear-time extraction of Cyrillic phrases with zero regex backtracking.
    # Split content by HTML boundaries, quote signs, curlies, equals, newlines, and brackets.
    phrases = []
    blocks = re.split(r'[<>]', content)
    for block in blocks:
        if not has_cyrillic(block):
            continue
        # Split by typical programming syntax tokens to isolate text strings
        sub_blocks = re.split(r'[{}=;\n\r\t\"\'`\[\]]', block)
        for sb in sub_blocks:
            if has_cyrillic(sb):
                normalized = normalize_text(sb)
                if normalized and has_cyrillic(normalized) and len(normalized) > 1:
                    phrases.append(normalized)
    return phrases

def translate_text(text, target_lang):
    if not text or not text.strip():
        return ""
    time.sleep(0.05)
    try:
        url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=ru&tl={target_lang}&dt=t&q={urllib.parse.quote(text)}"
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=15) as response:
            data = json.loads(response.read().decode('utf-8'))
            if data and data[0]:
                translated = "".join(item[0] for item in data[0] if item[0])
                return translated.strip()
    except Exception as e:
        try:
            time.sleep(1.0)
            with urllib.request.urlopen(req, timeout=15) as response:
                data = json.loads(response.read().decode('utf-8'))
                if data and data[0]:
                    translated = "".join(item[0] for item in data[0] if item[0])
                    return translated.strip()
        except Exception as retry_err:
            print(f"Error translating '{text}' to {target_lang} (after retry): {retry_err}")
    return ""

def main():
    print("--- Starting final comprehensive translation scanner (Fast/Linear) ---")
    
    # Load cache (from separate JSON files)
    cache = {lang: {} for lang in TARGET_LANGS}
    os.makedirs(LOCALES_DIR, exist_ok=True)
    for lang in TARGET_LANGS:
        lang_file = os.path.join(LOCALES_DIR, f"{lang}.json")
        if os.path.exists(lang_file):
            try:
                with open(lang_file, 'r', encoding='utf-8') as f:
                    cache[lang] = json.load(f)
                print(f"Loaded existing cache for {lang} with {len(cache[lang])} translations.")
            except Exception as e:
                print(f"Failed to load cache for {lang}: {e}. Starting fresh.")
            
    unique_strings = set()
    
    # Gather all project files to scan
    files_to_scan = []
    files_to_scan.extend(get_files_recursive(VIEWS_DIR, '.ejs'))
    files_to_scan.extend(get_files_recursive(ROUTES_DIR, '.js'))
    if os.path.exists(SERVER_FILE):
        files_to_scan.append(SERVER_FILE)
    if os.path.exists(PUBLIC_JS_DIR):
        files_to_scan.extend(get_files_recursive(PUBLIC_JS_DIR, '.js'))
        
    print(f"Scanning {len(files_to_scan)} source files for Cyrillic phrases...")
    for file_path in files_to_scan:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            phrases = extract_cyrillic_phrases(content)
            for phrase in phrases:
                unique_strings.add(phrase)
        except Exception as e:
            print(f"Error parsing file {file_path}: {e}")
            
    print(f"Found total {len(unique_strings)} unique Russian strings.")
    
    # Identify tasks
    tasks = []
    for s in unique_strings:
        for lang in TARGET_LANGS:
            if s not in cache[lang] or not cache[lang][s]:
                tasks.append((s, lang))
                
    print(f"{len(tasks)} translation requests need to be made.")
    
    if not tasks:
        print("All translations are up to date!")
        return
        
    completed_count = 0
    total_tasks = len(tasks)
    
    def save_cache():
        for l in TARGET_LANGS:
            lang_file = os.path.join(LOCALES_DIR, f"{l}.json")
            with open(lang_file, 'w', encoding='utf-8') as f:
                json.dump(cache[l], f, ensure_ascii=False, indent=2)
    
    def worker(item):
        nonlocal completed_count
        s, lang = item
        if lang == 'ru':
            translated = s
        else:
            translated = translate_text(s, lang)
        
        with cache_lock:
            if translated:
                cache[lang][s] = translated
            completed_count += 1
            if completed_count % 20 == 0 or completed_count == total_tasks:
                print(f"Progress: [{completed_count}/{total_tasks}] translations completed.")
                save_cache()
                    
    # Execute translations concurrently
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = [executor.submit(worker, item) for item in tasks]
        for future in as_completed(futures):
            try:
                future.result()
            except Exception as e:
                print(f"Thread execution error: {e}")
                
    # Final save
    save_cache()
    print("--- Scan and translation complete! All dictionaries are saved. ---")

if __name__ == '__main__':
    main()
