"""Build speech-core/data/kanji-readings.txt from the Unicode Character Database's Unihan files.

    curl -LO https://www.unicode.org/Public/UCD/latest/ucd/Unihan.zip && unzip Unihan.zip
    python3 speech-core/tools/kanji_readings.py <unzipped dir> speech-core/data/kanji-readings.txt

One kanji a row: the character, a tab, and its Japanese readings (kJapanese: on readings in
katakana become hiragana, kun readings as given), space-separated. Only kanji in a Japanese
standard (kIRG_JSource: JIS X 0208, 0212, 0213, and the rest of the J sources but the Moji Joho
set), which covers what games write.
"""
import sys

KEEP = {'J0', 'J1', 'J13', 'J14', 'J13A', 'J4', 'JA', 'JH', 'J3', 'J3A'}


def hiragana(text):
    return ''.join(chr(ord(c) - 0x60) if 0x30A1 <= ord(c) <= 0x30F6 else c for c in text)


def main(source, target):
    keep = set()
    with open(f'{source}/Unihan_IRGSources.txt', encoding='utf-8') as f:
        for line in f:
            if '\tkIRG_JSource\t' in line:
                code, _, value = line.rstrip('\n').split('\t')
                if value.split('-')[0] in KEEP:
                    keep.add(code)
    rows = []
    with open(f'{source}/Unihan_Readings.txt', encoding='utf-8') as f:
        for line in f:
            if not line.startswith('U+'):
                continue
            code, field, value = line.rstrip('\n').split('\t')
            if field != 'kJapanese' or code not in keep:
                continue
            readings = []
            for reading in value.split():
                reading = hiragana(reading).replace('-', '').replace('.', '')
                if reading and reading not in readings:
                    readings.append(reading)
            if readings:
                rows.append(chr(int(code[2:], 16)) + '\t' + ' '.join(readings))
    with open(target, 'w', encoding='utf-8') as f:
        f.write('\n'.join(rows) + '\n')
    print(f'{len(rows)} kanji')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
