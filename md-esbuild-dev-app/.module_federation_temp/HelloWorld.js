
const _sfc_main = {
  data() {
    return {
      title: 'Remote Component in Action..',
    };
  },
};

import { toDisplayString as _toDisplayString, openBlock as _openBlock, createElementBlock as _createElementBlock } from "vue"

const _hoisted_1 = { style: {"color":"red"} }

function _sfc_render(_ctx, _cache, $props, $setup, $data, $options) {
  return (_openBlock(), _createElementBlock("div", _hoisted_1, _toDisplayString($data.title), 1))
}


import _export_sfc from ' plugin-vue:export-helper'
export default /*#__PURE__*/_export_sfc(_sfc_main, [['render',_sfc_render]])