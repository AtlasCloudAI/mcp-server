#!/usr/bin/env python3
# 按开放文档「专家」一节的硬性规则自检。跑法: python3 自检.py
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
P = lambda *a: os.path.join(HERE, *a)
bad, warn = [], []

pj = json.load(open(P('.codebuddy-plugin', 'plugin.json'), encoding='utf-8'))

for f in ['name','expertType','version','description','author','agents','agentName',
          'displayName','profession','displayDescription','avatar','categoryId',
          'defaultInitPrompt','plugin','tags','quickPrompts']:
    if f not in pj: bad.append(f'plugin.json 缺必填字段 {f}')

if not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', pj.get('name','')):
    bad.append('name 必须是小写字母+连字符')
if pj.get('expertType') not in ('agent','team'):
    bad.append('expertType 只能是 agent 或 team')
if pj.get('expertType')=='team' and 'teamInfo' not in pj:
    bad.append('expertType=team 必须有 teamInfo')
if pj.get('plugin') != pj.get('name'):
    bad.append('plugin 字段必须与 name 一致')

CATS = {'01-ProductDesign','02-Engineering','03-GameSpatial','04-DataAI','05-MarketingGrowth',
        '06-ContentCreative','07-SalesCommerce','08-FinanceInvestment','09-OperationsHR',
        '10-ProjectQuality','11-SecurityCompliance','12-IndustryConsultant','13-TencentZone',
        '14-WorldWise','15-Education'}
if pj.get('categoryId') not in CATS:
    bad.append(f'categoryId 不在行业分类表里: {pj.get("categoryId")}')

# displayDescription.zh 中文字数 40-50（两种口径都要落在区间内）
zh = pj.get('displayDescription',{}).get('zh','')
han  = len(re.findall(r'[一-鿿]', zh))
dense = len(re.sub(r'\s', '', zh))
print(f'  displayDescription.zh  汉字={han}  去空格总字符={dense}')
for label, n in (('汉字口径', han), ('含标点口径', dense)):
    if not (40 <= n <= 50):
        bad.append(f'displayDescription.zh {label} {n} 字，不在 40-50 区间')

for f,n in (('tags',3),('quickPrompts',3)):
    if len(pj.get(f,[])) != n:
        bad.append(f'{f} 必须固定 {n} 个，现在是 {len(pj.get(f,[]))} 个')
    for i,it in enumerate(pj.get(f,[])):
        for lang in ('en','zh'):
            if not it.get(lang): bad.append(f'{f}[{i}] 缺 {lang}')

for f in ('displayName','profession','displayDescription','defaultInitPrompt'):
    for lang in ('en','zh'):
        if not pj.get(f,{}).get(lang): bad.append(f'{f} 缺 {lang}')

qp = pj.get('quickPrompts',[])
if qp:
    for lang in ('zh','en'):
        if pj.get('defaultInitPrompt',{}).get(lang) != qp[0].get(lang):
            bad.append(f'defaultInitPrompt.{lang} 必须与 quickPrompts 第一条完全一致')

# agents 路径与 agentName
agents = pj.get('agents',[])
if not agents: bad.append('agents 列表为空')
for rel in agents:
    if not os.path.isfile(P(rel)): bad.append(f'agents 路径不存在: {rel}')
names = [os.path.basename(a)[:-3] for a in agents]
if pj.get('agentName') not in names:
    bad.append(f'agentName "{pj.get("agentName")}" 在 agents/ 下找不到同名 md（现有 {names}）')

# agent frontmatter
for rel in agents:
    p = P(rel)
    if not os.path.isfile(p): continue
    m = re.match(r'^---\n(.*?)\n---\n', open(p,encoding='utf-8').read(), re.S)
    if not m: bad.append(f'{rel} 没有 YAML frontmatter'); continue
    fm = m.group(1)
    for f in ('name','description','displayName','profession'):
        if not re.search(rf'^{f}:', fm, re.M): bad.append(f'{rel} frontmatter 缺 {f}')
    nm = re.search(r'^name:\s*(\S+)', fm, re.M)
    if nm and nm.group(1) != os.path.basename(rel)[:-3]:
        bad.append(f'{rel} frontmatter name 与文件名不一致')
    if re.search(r'^tools:', fm, re.M):
        bad.append(f'{rel} 不允许自行声明 tools（工具由系统统一分配）')

# skills 路径
for rel in pj.get('skills',[]):
    if not os.path.isfile(P(rel,'SKILL.md')):
        warn.append(f'skills 路径 {rel} 下没有 SKILL.md（打包脚本会从 ../skills 复制进来）')

# dependencies.connectors 必须与兄弟目录连接器的 source 一致
deps = pj.get('dependencies', {}).get('connectors', [])
meta_p = P('..', 'connector-meta.json')
for cid in deps:
    if not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', cid):
        bad.append(f'dependencies.connectors "{cid}" 不是 kebab-case')
if deps and os.path.isfile(meta_p):
    src = json.load(open(meta_p, encoding='utf-8')).get('source')
    # 依据：连接器文档给的回调是 workbuddy://workbuddy/mcp/connector%3A<source>/oauth/callback，
    # 客户端 toRuntimeMcpConfigId 拼的是 `connector:` + configId → configId 就是 source。
    if src and src not in deps:
        bad.append(f'dependencies.connectors {deps} 不含兄弟连接器的 source "{src}"')
    elif src:
        print(f'  dependencies.connectors 对上 ../connector-meta.json 的 source="{src}"  ✓')

# 头像
av = P(pj.get('avatar','avatars/expert.png'))
if not os.path.isfile(av):
    bad.append(f'头像缺失: {pj.get("avatar")}（要求 PNG 512x512、<500KB）')
else:
    sz = os.path.getsize(av)
    if sz > 500*1024: bad.append(f'头像 {sz//1024}KB 超过 500KB')
    try:
        from PIL import Image
        w,h = Image.open(av).size
        if (w,h)!=(512,512): bad.append(f'头像尺寸 {w}x{h}，要求 512x512')
        else: print(f'  头像 512x512  {sz//1024}KB  ✓')
    except ImportError: warn.append('未装 Pillow，跳过头像尺寸校验')

# 会随包发给腾讯审核员的文件里，不能出现内部状态
# （2026-09-20 实测：README 曾把草稿 id、后端阻塞点、以及对官方模板的评价一起打进 zip）
# 只放高信号词：这些字串在对外物料里没有任何正当出现理由。
# 别加「草稿」「卡在」「待确认」这类通用词 —— 试过，技能正文里「生成草稿」
# 「不会卡在开通流程上」全被误判，噪声会让人直接忽略这条检查。
LEAK = re.compile(r'oc_[0-9a-f]{8}|OAuth改造需求|工程笔记|给后端|官方模板|gaokao|design-experts')
packaged = [P('README.md')] + [P(a) for a in agents]
# 技能目录的真身在 ../skills/（打包时复制进来），这里要跟过去扫，否则等于没扫
for rel in pj.get('skills', []):
    d = P(rel) if os.path.isdir(P(rel)) else P('..', 'skills', os.path.basename(rel))
    for root, _, fs in os.walk(d):
        packaged += [os.path.join(root, f) for f in fs]
print(f'  外发文件 {len(packaged)} 个，逐行扫内部信息')
for f in packaged:
    if not os.path.isfile(f): continue
    rel = os.path.relpath(f, HERE)
    for i, line in enumerate(open(f, encoding='utf-8', errors='ignore'), 1):
        m = LEAK.search(line)
        if m: bad.append(f'{rel}:{i} 含内部信息 "{m.group()}" —— 这个文件会进 zip 发给审核员')

# 不该出现的东西
SECRET = re.compile('apikey' + '-|sk' + r'-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY')
for root,_,files in os.walk(HERE):
    for f in files:
        if os.path.abspath(os.path.join(root,f)) == os.path.abspath(__file__): continue
        if SECRET.search(open(os.path.join(root,f),encoding='utf-8',errors='ignore').read()):
            bad.append(f'疑似凭据出现在 {os.path.relpath(os.path.join(root,f),HERE)}')

print()
for b in bad:  print('  ✗', b)
for w in warn: print('  !', w)
if not bad: print('  全部通过 ✓')
sys.exit(1 if bad else 0)
