/* =============================================================================
 * schema.js —— 表单字段定义（唯一真源）
 * =============================================================================
 * 严格对齐《1.1 AGV项目需求调研表 B.3.0》表1-项目基本情况（R2~R81）。
 * 每个字段的 label / unit 照抄原表，不重命名、不调整顺序。
 * 字段清单来源：agv_form/refs/字段清单.csv（由 survey_map.json + 空白表核对生成）
 *
 * 类型说明
 *   text      单行文本
 *   textarea  多行文本
 *   number    数值 —— 支持 4 种回答方式：single(精确)/range(范围)/ge(大于等于)/unknown(不确定)
 *   select    下拉（options 数组；allowOther=可填"其它"）
 *   multi     多选（按钮组）
 *   date      日期
 * ========================================================================== */
(function (g) {
  'use strict';

  /* ---------------- 可复用字段集 ---------------- */
  // 物料 A（原表 R15~R18）
  var MATERIAL_FIELDS = [
    { key: 'pack_form', label: '包装形式', type: 'select', allowOther: true,
      options: ['袋装', '箱装', '定制包装', '无包装'], hint: '客户现场物料的外包装形式' },
    { key: 'pack_size', label: '尺寸', unit: 'mm', type: 'number', modes: ['single', 'range'],
      placeholder: '长×宽×高，如 600×400×300' },
    { key: 'material_weight', label: '重量', unit: 'kg', type: 'number', modes: ['single', 'range'] },
    { key: 'info_record', label: '信息记录形式', type: 'multi',
      options: ['一维码', '二维码', '电子标签（RFID）', '无'] }
  ];

  // 载具 B（原表 R24~R29）
  var CARRIER_FIELDS = [
    { key: 'carrier_for_material', label: '对应物料', type: 'text',
      placeholder: '该载具装的是上面哪号物料？如 A1、A2' },
    { key: 'carrier_type', label: '载具类型', type: 'select', allowOther: true,
      options: ['田字托盘', '川字托盘', '料箱', '定制载具'],
      hint: '田字托盘/川字托盘/料箱/定制载具' },
    { key: 'fork_entry', label: '进叉方向', type: 'select',
      options: ['短边进叉', '长边进叉'], optional: true },
    { key: 'carrier_material', label: '载具材质', type: 'select', allowOther: true,
      options: ['木制', '钢制', '塑料'] },
    { key: 'carrier_weight', label: '载具自重', unit: 'kg', type: 'number', modes: ['single'] },
    { key: 'carrier_info_record', label: '信息记录形式', type: 'multi',
      options: ['一维码', '二维码', '电子标签（RFID）', '无'] }
  ];

  // 载具+物料组合 C（原表 R31~R42，12 项尺寸）
  var COMBO_FIELDS = [
    { key: 'stack_mode', label: '码盘形式', type: 'select', allowOther: true,
      options: ['人工码盘', '自动码盘'] },
    { key: 'load_weight', label: '载具+物料满载重量', unit: 'Kg', type: 'number',
      modes: ['single', 'range'], hint: '可分别填最大重量与平均重量' },
    { key: 'pallet_length', label: 'L（托盘长）', unit: 'mm', type: 'number', modes: ['single'],
      hint: '沿货叉方向' },
    { key: 'cargo_length', label: 'L’（货物长）', unit: 'mm', type: 'number', modes: ['single'] },
    { key: 'dim_L1', label: 'L1', unit: 'mm', type: 'number', modes: ['single'],
      hint: '见原表 G 列示意图' },
    { key: 'dim_L2', label: 'L2', unit: 'mm', type: 'number', modes: ['single'] },
    { key: 'fork_hole_width', label: 'L3（插孔宽）', unit: 'mm', type: 'number', modes: ['single'] },
    { key: 'pallet_width', label: 'W（托盘宽）', unit: 'mm', type: 'number', modes: ['single'],
      hint: '垂直于货叉方向' },
    { key: 'cargo_width', label: 'W’（货物宽）', unit: 'mm', type: 'number', modes: ['single'] },
    { key: 'cargo_height', label: 'H（货物+托盘总高）', unit: 'mm', type: 'number', modes: ['single'] },
    { key: 'pallet_height', label: 'h（托盘高）', unit: 'mm', type: 'number', modes: ['single'] },
    { key: 'fork_hole_height', label: 'h1（叉孔高）', unit: 'mm', type: 'number', modes: ['single'],
      hint: '木托盘 h1≥100mm 为佳' }
  ];

  // 流程 D（原表 R55~R59）
  var FLOW_FIELDS = [
    { key: 'pick_point', label: '取货点位置', type: 'text', placeholder: '如 1F 原料库 A 区' },
    { key: 'drop_point', label: '放货点位置', type: 'text', placeholder: '如 2F 包装线 3 号工位' },
    { key: 'flow_material', label: '物料类型', type: 'text', placeholder: '对应物料 A? ' },
    { key: 'flow_carrier', label: '载具类型', type: 'text', placeholder: '对应载具 B?' },
    { key: 'flow_rate', label: '节拍', unit: '托/h', type: 'number', modes: ['single', 'range'] }
  ];

  /* ---------------- 分组步骤 ---------------- */
  var STEPS = [
    {
      id: 'basic', no: 1, title: '基本信息', sub: '原表 R2~R9',
      groups: [{
        id: 'basic', title: '', fields: [
          { key: 'customer_name', label: '单位名称', type: 'text', required: true },
          { key: 'project_name', label: '项目名称', type: 'text', required: true },
          { key: 'site_address', label: '项目实施地址', type: 'text', required: true,
            hint: '请填写国家/城市，用于判断适用地区标准' },
          { key: 'contact', label: '联系人', type: 'text' },
          { key: 'position', label: '职位', type: 'text' },
          { key: 'contact_info', label: '联系方式', type: 'text', placeholder: '电话 / 邮箱' },
          { key: 'kickoff', label: '项目启动时间', type: 'text', placeholder: '如 2027年3月' },
          { key: 'purchase_mode', label: '采购形式', type: 'text', placeholder: '如 公开招标 / 议标' }
        ]
      }]
    },
    {
      id: 'material', no: 2, title: '物料信息', sub: '原表 R11~R22',
      groups: [
        {
          id: 'material_overview', title: '概述', fields: [
            { key: 'sku_count', label: '物料规格数量（SKU）', unit: '种', type: 'number', modes: ['single'] },
            { key: 'material_desc', label: '物料总体描述', type: 'textarea',
              placeholder: '是什么东西、大致形态、有无特殊要求' },
            { key: 'material_attr', label: '物料属性', type: 'multi',
              options: ['易燃', '易爆', '易碎', '常规', '其它'] }
          ]
        }
      ],
      repeat: { id: 'material', prefix: 'A', label: '物料', min: 1, note: '物料 A1、A2…', fields: MATERIAL_FIELDS }
    },
    {
      id: 'carrier', no: 3, title: '载具信息', sub: '原表 R23~R29',
      repeat: { id: 'carrier', prefix: 'B', label: '载具', min: 1, note: '载具 B1、B2…', fields: CARRIER_FIELDS }
    },
    {
      id: 'combo', no: 4, title: '载具 + 物料组合', sub: '原表 R30~R54',
      repeat: {
        id: 'combo', prefix: 'C', label: '组合', min: 1, note: '组合 C1、C2…',
        // S3 语义：每个 C 自己选它由哪号物料 + 哪号载具构成
        refs: [
          { key: 'ref_material', label: '由哪个物料', ref: 'material', prefix: 'A' },
          { key: 'ref_carrier', label: '由哪个载具', ref: 'carrier', prefix: 'B' }
        ],
        fields: COMBO_FIELDS
      }
    },
    {
      id: 'flow', no: 5, title: '物流流程', sub: '原表 R55~R64',
      repeat: { id: 'flow', prefix: 'D', label: '流程', min: 1, note: '流程 D1、D2…', fields: FLOW_FIELDS }
    },
    {
      id: 'process', no: 6, title: '工艺流程', sub: '原表 R65', groups: [{
        id: 'process', title: '', fields: [
          { key: 'process_text', label: '工艺流程说明', type: 'textarea', wide: true,
            hint: '请针对项目产品对象，从工艺流程、现场工艺布局、客户对物料转运的要求等方面描述' }
        ]
      }]
    },
    {
      id: 'site', no: 7, title: '现场信息', sub: '原表 R66~R75',
      groups: [{
        id: 'site', title: '现场环境', fields: [
          { key: 'temperature', label: '温度范围', unit: '℃', type: 'number', modes: ['single', 'range'],
            hint: '若有冷库/冷冻区请填最低温度' },
          { key: 'building_height', label: '厂房限高', unit: 'm', type: 'number', modes: ['single'] },
          { key: 'slope', label: '地面坡度', unit: '°', type: 'number', modes: ['single', 'ge'] },
          { key: 'floor_capacity', label: '地面、楼板承重', unit: 't/㎡', type: 'number', modes: ['single', 'ge'] },
          { key: 'floor_condition', label: '地面综合情况', type: 'select', allowOther: true,
            options: ['良好（平整、无裂缝）', '一般', '较差（起伏/裂缝/油污）', '不确定'],
            hint: '目测地面是否平整、有无缝隙（>4cm 需注意）' },
          { key: 'glare', label: '场景中是否有高反光情况', type: 'select',
            options: ['有', '无', '不确定'],
            hint: '高反光玻璃、焊接弧光等会影响导航' },
          { key: 'dust', label: '气体粉尘', type: 'select', options: ['有', '无', '不确定'],
            hint: '是否存在易燃易导电的气体和粉尘' }
        ]
      }, {
        id: 'work', title: '工作模式', fields: [
          { key: 'existing_equipment', label: '现有搬运设备及数量', type: 'text',
            placeholder: '目前采用什么车型、多少台' },
          { key: 'driver_count', label: '现有司机人数', unit: '人', type: 'number', modes: ['single'] },
          { key: 'work_time', label: '工作时间', type: 'text',
            placeholder: '几班倒？单班多少小时？', hint: '如 两班倒，每班 10 小时' }
        ]
      }]
    },
    {
      id: 'system', no: 8, title: '系统对接', sub: '原表 R76~R81',
      groups: [{
        id: 'system', title: '', fields: [
          { key: 'erp', label: 'ERP/MES 系统', type: 'select', allowOther: true,
            options: ['有', '无', '不确定'], hint: '如有请注明系统名称' },
          { key: 'wms', label: 'WMS 系统', type: 'select', allowOther: true,
            options: ['有', '无', '不确定'] },
          { key: 'site_devices', label: '现场设备', type: 'textarea',
            hint: '产线接驳位、输送线、提升机、机械臂、电动门、电梯、红绿灯等，及是否开放接口' },
          { key: 'trigger_by_system', label: '搬运信息触发', type: 'select',
            options: ['是', '否', '不确定'],
            hint: '客户系统（ERP/MES/WMS）是否直接触发物料转运' },
          { key: 'trigger_mode', label: '客户期望触发形式', type: 'select', allowOther: true,
            options: ['系统联机自动运行', 'PDA', 'PAD', '按钮'] },
          { key: 'trigger_place', label: '客户期望触发地点', type: 'select', allowOther: true,
            options: ['站点旁', '集中区域'] }
        ]
      }]
    },
    {
      id: 'extra', no: 9, title: '选型必需补充', sub: '原表无此栏，但影响车型选择',
      groups: [{
        id: 'extra', title: '以下几项原调研表没有，但直接决定能不能选对车型', fields: [
          { key: 'aisle_width_mm', label: '现场实际通道宽度最小值', unit: 'mm', type: 'number',
            modes: ['single', 'ge'], required: true,
            hint: '直角堆垛通道最窄处；不确定可填大致值并在备注说明' },
          { key: 'site_environment', label: '运行环境', type: 'select', required: true,
            options: ['室内', '室外', '冷库'],
            hint: '月台/雨棚段按室内计；多处不同可分别说明' },
          { key: 'stacking_layers', label: '堆叠层数 / 货架层数', type: 'number', modes: ['single'],
            hint: '用于计算举升高度 = 总高 ×（层数−1）+ 托盘高' }
        ]
      }]
    },
    {
      id: 'other', no: 10, title: '其他需求', sub: '原表 R82 之后',
      groups: [{
        id: 'other', title: '', fields: [
          { key: 'other_requirements', label: '其他需求', type: 'textarea', wide: true,
            hint: '指定车型、特殊条件等', required: false }
        ]
      }]
    }
  ];

  /* ---------------- 附件上传区 ---------------- */
  var UPLOAD_ZONES = [
    { id: 'site_photos', title: '现场照片 / 视频', accept: 'image/*,video/*',
      desc: '仓库整体、地面状况、门洞、接驳处、运行通道等', max: 30 },
    { id: 'material_photos', title: '物料 / 载具照片', accept: 'image/*,video/*',
      desc: '各类物料与托盘/料箱的实物照片，便于确认尺寸', max: 20 },
    { id: 'drawings', title: '平面图 / CAD 图纸', accept: 'image/*,.pdf,.dwg,.dxf,.zip,.rar',
      desc: '厂区平面布局图、物流动线图；无 CAD 可拍图纸照片', max: 10 }
  ];

  g.AGV_SCHEMA = {
    version: '1.0',
    title: 'AGV 项目需求调研',
    subtitle: '《1.1 AGV项目需求调研表 B.3.0》',
    steps: STEPS,
    uploadZones: UPLOAD_ZONES
  };
})(typeof window !== 'undefined' ? window : globalThis);
