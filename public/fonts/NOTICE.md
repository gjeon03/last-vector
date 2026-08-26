# NanumSquare Neo font notice

This directory contains three byte-unmodified WOFF2 files copied from NAVER's official NanumSquare Neo distribution. The files were not subsetted, converted, recompressed, or edited.

## Sources and retrieval

- Product page: https://campaign.naver.com/nanumsquare_neo/
- Official archive: https://campaign.naver.com/nanumsquare_neo/download/NaverNanumSquareNeo.zip
- Retrieved: 2026-08-24 (Asia/Seoul)
- Archive size: 26,666,204 bytes
- Archive SHA-256: `aba166203bf7637324f1d923bcf9501eb276cfca044c1ad714ba06b1e61a15cc`
- NAVER license notice: https://help.naver.com/service/30016/contents/18088?lang=ko&osType=PC
- Official SIL OFL 1.1 English text: https://software.sil.org/downloads/r/oflt/OFL.txt

The upstream ZIP archive contains no license, NOTICE, or README file. `OFL.txt` therefore combines NAVER's official 2010 copyright and Reserved Font Name declaration from the NAVER license notice with the complete English SIL Open Font License 1.1 body from SIL's official source; it is not represented as a file extracted from the ZIP.

## Exact file mappings

The ZIP stores `웹폰트` in Unicode NFD. The paths below are normalized to NFC for display only; the extracted font bytes were copied without modification.

| Repository file | Official archive entry | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `NanumSquareNeo-Light.woff2` | `NanumSquareNeo/웹폰트/woff2/NanumSquareNeoTTF-aLt.woff2` | 339380 | `f0da0f2329935d3f88f7e4162b68fcdc0be393f74398736ea0967594282ca4e2` |
| `NanumSquareNeo-Regular.woff2` | `NanumSquareNeo/웹폰트/woff2/NanumSquareNeoTTF-bRg.woff2` | 387104 | `d13846b612acc829078aff4f91c272c637c08441b409d46bb1a4c802eb2967c3` |
| `NanumSquareNeo-Bold.woff2` | `NanumSquareNeo/웹폰트/woff2/NanumSquareNeoTTF-cBd.woff2` | 384992 | `97dfe9720fbed813fc988fcedbcf741e97eef9353515b2043717484ec0b90aa1` |

Repository filenames changed from the upstream weight-code filenames, and the CSS family alias changed to `NanumSquare Neo Hangul`; the embedded names are unchanged. These naming changes do not modify or rename the Font Software itself.

The Light binary reports OS/2 weight 350. Mapping that face to CSS weight 300 is intentional so it occupies the existing light UI weight while preserving the original font bytes and embedded metadata.

## Copyright and license declarations

NAVER's official license notice declares:

> Copyright (c) 2010, NAVER Corporation (https://www.navercorp.com/) with Reserved Font Name Nanum, Naver Nanum, NanumGothic, Naver NanumGothic, NanumMyeongjo, Naver NanumMyeongjo, NanumBrush, Naver NanumBrush, NanumPen, Naver NanumPen, Naver NanumGothicEco, NanumGothicEco, Naver NanumMyeongjoEco, NanumMyeongjoEco, Naver NanumGothicLight, NanumGothicLight, NanumBarunGothic, Naver NanumBarunGothic, NanumSquareRound, NanumBarunPen, MaruBuri, NanumSquareNeo

It licenses the Font Software under SIL Open Font License 1.1 and includes `NanumSquareNeo` in the Reserved Font Name declaration.

All three WOFF2 files contain this embedded metadata:

> Copyright © 2022 NAVER Corp. All rights reserved. Font Designed by Sandoll Inc.
