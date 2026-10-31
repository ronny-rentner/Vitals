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

import {colorStyle} from './helpers/colors.js';

// Units as the standards write them (SI, and IEC 80000-13 for bits and bytes): the prefix for a thousand is a
// lowercase "k", the one for 1024 is "Ki", and a rate is the unit with "/s".
const decimal = ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
const binary = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
const hertz = ['Hz', 'kHz', 'MHz', 'GHz', 'THz', 'PHz', 'EHz', 'ZHz'];

export class Formatter {
    constructor(settings) {
        this._settings = settings;
    }

    // What a colour breakpoint means for a kind of value: the number of `value` that a breakpoint is compared with,
    // the unit that number is in, and how many decimals a breakpoint has. A value that is shown scaled, such as a
    // size, has one fixed unit here, so that a breakpoint means the same for a small value and a large one.
    // Nothing for a kind of value that is text.
    colorScale(format, value = 0) {
        let thousand = this._settings.get_int((format == 'memory' ? 'memory' : 'storage') + '-measurement') ? 1000 : 1024;
        let bits = this._settings.get_int('network-speed-format') == 1;
        switch (format) {
            case 'percent': return [Math.min(value * 100, 100), '%', 0];
            case 'temp': return this._settings.get_int('unit') == 1 ? [value * 9 / 5 + 32, '°F', 0] : [value, '°C', 0];
            case 'in': return [value, 'V', 1];
            case 'fan': return [value, 'RPM', 0];
            case 'watt':
            case 'watt-gpu':
            case 'watt-limit':
            case 'power': return [value, 'W', 1];
            case 'watt-hour': return [value, 'Wh', 1];
            case 'load': return [value, '', 1];
            case 'hertz': return [value / 1e9, 'GHz', 1];
            case 'memory':
            case 'storage': return [value / thousand ** 3, thousand == 1000 ? 'GB' : 'GiB', 1];
            case 'storage-rate': return [value / thousand ** 2, thousand == 1000 ? 'MB/s' : 'MiB/s', 1];
            case 'speed': return bits ? [value * 8 / 1e6, 'Mbit/s', 1] : [value / 1e6, 'MB/s', 1];
            case 'runtime':
            case 'uptime': return [value / 60, 'min', 0];
        }
    }

    // `colorTarget` names the sensor in the colour settings: its category and key, as `category/key`. `lowIsBad`
    // is the sensor's field of that name. Returns the text, its colour style, and the unit the text ends with
    // ('' when it has none), so that the unit can be drawn differently from the number.
    // `rounding` supplies a total and operands from one reading; a difference subtracts the rounded operands.
    format(value, format, categoryName, colorTarget, lowIsBad, rounding) {
        let precise = this._settings.get_boolean('use-higher-precision');
        let numeric = typeof value == 'number' ? this.colorScale(format, value)?.[0] : undefined;
        let text;
        let unit = '';
        switch (format) {
            case 'percent':
                unit = ' %';
                text = (precise ? numeric.toFixed(1) : String(Math.trunc(numeric))) + unit;
                break;
            case 'temp':
                unit = this._settings.get_int('unit') == 1 ? ' °F' : ' °C';
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
                // A breakdown shares its total's unit; differences use rounded operands so the displayed rows add up.
                let unitValue = rounding ? rounding.total : value;
                // Speeds start at kB/s (kbit/s): below that, the unit of a quiet network would change at every reading.
                let exponent = fixed || Math.max(format == 'speed' ? 1 : 0, unitValue > 0 ? Math.floor(Math.log(unitValue) / Math.log(base)) : 0);
                if (!fixed && unitValue >= Math.pow(base, exponent) * (base - 0.05)) exponent++;
                let scaled = value / Math.pow(base, exponent);
                // A speed has one decimal below 10 and none from there on, so it keeps two or three digits.
                let digits = format == 'speed' ? (scaled < 9.95 ? 1 : 0) + (precise ? 1 : 0) : (precise ? 2 : 1);
                if (rounding)
                    scaled = rounding.operands.map(operand => Math.round(operand / Math.pow(base, exponent) * 10 ** digits))
                        .reduce((left, right) => left - right) / 10 ** digits;
                let ending = units[exponent];
                if (format == 'speed') ending = (bits ? ending.replace('B', 'bit') : ending) + '/s';
                if (format == 'storage-rate') ending += '/s';
                unit = ' ' + ending;
                text = scaled.toFixed(digits) + unit;
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
            case 'power':
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
        let style = numeric === undefined ? ''
            : colorStyle(numeric, this._settings.get_strv(categoryName + '-colors'), 'sensor:' + colorTarget, 'kind:' + format, lowIsBad);
        return {text, unit, style};
    }
}
