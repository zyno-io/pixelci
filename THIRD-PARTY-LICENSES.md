THIRD-PARTY SOFTWARE LICENSES

PixelCI includes or depends on third-party software components subject to
the following licenses. The full license texts are included in each
package's directory under node_modules/, or in licenses/ where a package
does not include its own.

================================================================================

node-forge
Version: 1.3.3
License: BSD-3-Clause (chosen from dual-license: BSD-3-Clause OR GPL-2.0)
Copyright: (c) 2010, Digital Bazaar, Inc. All rights reserved.
Source: https://github.com/digitalbazaar/forge

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

- Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.
- Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
- Neither the name of Digital Bazaar, Inc. nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL DIGITAL BAZAAR BE LIABLE FOR ANY DIRECT,
INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH
DAMAGES.

================================================================================

libvips and its bundled libraries (via sharp)
Package: @img/sharp-libvips-<platform> 1.2.4 (used by sharp 0.34)
Source: https://github.com/lovell/sharp-libvips/tree/v1.2.4
Versions of each library: node_modules/@img/sharp-libvips-<platform>/versions.json

These are shared libraries, loaded dynamically by sharp from
node_modules/@img/sharp-libvips-<platform>/lib/, and are not modified by
PixelCI. You may replace them with your own builds of the same libraries.
Corresponding source for each library is available from the source above.

Licensed under the GNU Lesser General Public License, version 3 (used via
the "any later version" clause of LGPLv2/LGPLv2.1); texts in
licenses/LGPL-3.0.txt and licenses/GPL-3.0.txt:
libvips, glib, pango, fribidi, libexif, libheif, librsvg, proxy-libintl

Licensed under the Mozilla Public License 2.0
(https://www.mozilla.org/en-US/MPL/2.0/):
cairo

Licensed under BSD 2-Clause plus the Alliance for Open Media Patent License
1.0 (https://aomedia.org/license/patent-license/):
aom

The remaining bundled libraries (cgif, expat, fontconfig, freetype,
harfbuzz, highway, lcms, libarchive, libffi, libimagequant, libnsgif,
libpng, libspng, libtiff, libwebp, libxml2, mozjpeg, pixman, zlib-ng) are
under permissive licenses (MIT, BSD, zlib, libpng, IJG, Apache-2.0 or
similar), listed in the sharp-libvips README.

================================================================================

All other dependencies are licensed under permissive terms (MIT, Apache-2.0,
ISC, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0, CC0-1.0, 0BSD, or similar).
Their license files are included in their respective node_modules/
directories within the distributed Docker image.
