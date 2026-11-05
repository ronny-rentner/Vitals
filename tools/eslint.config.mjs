// SPDX-FileCopyrightText: 2025 Florian Müllner <fmuellner@gnome.org>
// SPDX-License-Identifier: MIT OR LGPL-2.1-or-later

// https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/eslint.config.js
import {defineConfig} from '@eslint/config-helpers';
import gnome from './gnome-recommended.mjs';

export default defineConfig([
    gnome,
    {
        ignores: ['build/**'],
    }, {
        rules: {
            camelcase: ['error', {
                properties: 'never',
            }],
            'consistent-return': 'error',
            'eqeqeq': ['error', 'smart'],
            'key-spacing': ['error', {
                mode: 'minimum',
                beforeColon: false,
                afterColon: true,
            }],
            'prefer-arrow-callback': 'error',
            'prefer-const': ['error', {
                destructuring: 'all',
            }],
        },
    }, {
        files: [
            'extension.js',
            'menuItem.js',
            'sensors.js',
            'croppedIcon.js',
            'tests/shell.test.js',
            'tests/croppedIcon.test.js',
            'docs/screenshots/screenshots.js',
        ],
        languageOptions: {
            globals: {
                global: 'readonly',
            },
        },
    },
]);
