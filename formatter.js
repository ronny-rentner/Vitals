/*
  Copyright (c) 2018, Chris Monahan <chris@corecoding.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the GNOME nor the names of its contributors may be
      used to endorse or promote products derived from this software without
      specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
  ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
  DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import {colorsKeyForSensor} from './helpers/categories.js';
import {getUsageColor} from './helpers/colors.js';

const decimal = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
const binary = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
const hertz = ['Hz', 'KHz', 'MHz', 'GHz', 'THz', 'PHz', 'EHz', 'ZHz'];

export class Formatter {
    constructor(settings) {
        this._settings = settings;
    }

    // `colorTarget` names the sensor in the threshold-colour settings: its category and key, as `category/key`.
    // Returns the text, its colour style, and the unit the text ends with ('' when it has none), so that the unit
    // can be drawn differently from the number.
    format(value, format, categoryName, colorTarget) {
        let precise = this._settings.get_boolean('use-higher-precision');
        let numeric = typeof value == 'number' ? value : null;
        let text;
        let unit = '';
        switch (format) {
            case 'percent':
                numeric = Math.min(value * 100, 100);
                unit = '%';
                text = (precise ? numeric.toFixed(1) : String(Math.trunc(numeric))) + unit;
                break;
            case 'temp':
                numeric = this._settings.get_int('unit') == 1 ? value * 9 / 5 + 32 : value;
                unit = this._settings.get_int('unit') == 1 ? '°F' : '°C';
                text = (precise ? numeric.toFixed(1) : String(Math.trunc(numeric))) + unit;
                break;
            case 'in':
                unit = ' V';
                text = value.toFixed(precise ? 2 : 1) + unit;
                break;
            case 'fan':
                unit = ' RPM';
                text = Math.trunc(value) + unit;
                break;
            case 'hertz':
            case 'memory':
            case 'storage':
            case 'storage-rate':
            case 'speed': {
                let base = 1000;
                let units = format == 'hertz' ? hertz : decimal;
                if (format == 'memory' || format == 'storage' || format == 'storage-rate') {
                    base = this._settings.get_int((format == 'memory' ? 'memory' : 'storage') + '-measurement') ? 1000 : 1024;
                    units = base == 1000 ? decimal : binary;
                }
                let bits = format == 'speed' && this._settings.get_int('network-speed-format') == 1;
                if (bits) value *= 8;
                let fixed = format == 'speed' ? this._settings.get_int('network-speed-unit') : 0;
                let exponent = fixed || (value > 0 ? Math.max(0, Math.floor(Math.log(value) / Math.log(base))) : 0);
                if (!fixed && value >= Math.pow(base, exponent) * (base - 0.05)) exponent++;
                let digits = format == 'speed' ? (precise ? 1 : 0) : (precise ? 2 : 1);
                let ending = units[exponent];
                if (format == 'speed') ending = bits ? ending.replace('B', 'bps') : ending + '/s';
                if (format == 'storage-rate') ending += '/s';
                unit = ' ' + ending;
                text = (value / Math.pow(base, exponent)).toFixed(digits) + unit;
                break;
            }
            case 'runtime':
            case 'uptime': {
                if (typeof value == 'string') {
                    text = value;
                    break;
                }
                let units = [[86400, 'd'], [3600, 'h'], [60, 'm']];
                let seconds = format == 'uptime' && (precise || value < 60);
                if (seconds) units.push([1, 's']);
                let parts = [];
                for (let [size, ending] of units) {
                    let amount = Math.floor(value / size);
                    if (amount || parts.length) parts.push(amount + ending);
                    value %= size;
                }
                text = parts.length ? parts.join(' ') : seconds ? '0s' : '0m';
                break;
            }
            case 'watt':
                unit = ' W';
                text = (value > 0 ? '+' : '') + value.toFixed(precise ? 2 : 1) + unit;
                break;
            case 'watt-gpu':
                unit = ' W';
                text = value.toFixed(precise ? 2 : 1) + unit;
                break;
            case 'watt-limit':
                unit = ' W';
                text = value.toFixed(0) + unit;
                break;
            case 'watt-hour':
                unit = ' Wh';
                text = value.toFixed(precise ? 2 : 1) + unit;
                break;
            case 'load':
                text = value.toFixed(precise ? 2 : 1);
                break;
            case 'pcie': {
                let [generation, width] = value.split('x').map(Number);
                text = 'PCIe ' + generation + (width === undefined ? '' : ' x' + width);
                break;
            }
            default:
                text = String(value);
        }
        let colors = colorsKeyForSensor(categoryName, format);
        let style = colors && numeric !== null
            ? getUsageColor(numeric, this._settings.get_strv(colors), colorTarget) : '';
        return {text, unit, style};
    }
}
