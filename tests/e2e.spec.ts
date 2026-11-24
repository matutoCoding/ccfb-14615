// 端到端精度验收：
// 1) 生成合成两期数据集（带 POS 噪声、过曝、缺 POS 异常照片）
// 2) 自动配准，验收重投影 RMS ≤ 1.5 px
// 3) 烘焙纹理
// 4) 裂缝长度在正射/烘焙链路上量测，相对误差 ≤ 2%
// 5) 复检对比能识别延伸与新增；报告评分链可运行
import { test, expect, type Page } from '@playwright/test';

async function gotoSelftest(page: Page): Promise<void> {
  await page.goto('/#/selftest');
  await expect(page.locator('h2')).toContainText('精度自测');
}

async function clickAndWait(page: Page, roleText: string, waitMs = 3000): Promise<void> {
  await page.getByRole('button', { name: roleText }).click();
  await page.waitForTimeout(waitMs);
}

test.describe('桥梁病害配准贴图系统端到端', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => indexedDB.deleteDatabase('bridge-inspection-db'));
    await page.goto('/');
    await page.waitForSelector('#sidebar');
  });

  test('合成数据 -> 配准(≤1.5px) -> 烘焙 -> 裂缝量测(≤2%) 全链路', async ({ page }) => {
    await gotoSelftest(page);

    // ① 生成
    await clickAndWait(page, '① 生成合成数据集（两期）', 2000);
    await page.waitForFunction(
      () => document.body.innerText.includes('数据集概览'),
      { timeout: 180_000 },
    );
    const summary = await page.locator('.card').allInnerTexts();
    expect(summary.join('')).toContain('控制点');

    // ② 自动配准
    await clickAndWait(page, '② 自动配准全部照片', 2000);
    await page.waitForFunction(
      () => document.body.innerText.includes('配准精度指标') && document.body.innerText.includes('重投影 RMS（平均）'),
      { timeout: 300_000 },
    );
    const regText = await page.locator('table').allInnerTexts();
    const joined = regText.join('\n');
    expect(joined).toContain('达标');
    // 平均 RMS 数值提取并断言
    const rmsMatch = joined.match(/重投影 RMS（平均）[\s\S]*?([0-9]+\.[0-9]+)\s*px/);
    expect(rmsMatch, '应能解析平均 RMS').toBeTruthy();
    const rmsAvg = parseFloat(rmsMatch![1]);
    expect(rmsAvg, '平均重投影 RMS 必须 ≤ 1.5 px').toBeLessThanOrEqual(1.5);
    const rmsMaxMatch = joined.match(/重投影 RMS（单张最大）[\s\S]*?([0-9]+\.[0-9]+)\s*px/);
    expect(parseFloat(rmsMaxMatch![1])).toBeLessThanOrEqual(1.5);

    // ③ 烘焙
    await clickAndWait(page, '③ 烘焙纹理', 2000);
    await page.waitForFunction(
      () => document.body.innerText.includes('纹理烘焙与量测精度'),
      { timeout: 300_000 },
    );

    // ④ 量测
    await clickAndWait(page, '④ 裂缝量测与精度评定', 2000);
    await page.waitForFunction(
      () => document.body.innerText.includes('裂缝长度最大相对误差'),
      { timeout: 180_000 },
    );
    const finalText = await page.locator('table').allInnerTexts();
    const all = finalText.join('\n');
    const errMatch = all.match(/裂缝长度最大相对误差[\s\S]*?([0-9]+\.[0-9]+)\s*%/);
    expect(errMatch, '应能解析裂缝最大误差').toBeTruthy();
    const maxErr = parseFloat(errMatch![1]);
    expect(maxErr, '裂缝长度最大相对误差必须 ≤ 2%').toBeLessThanOrEqual(2.0);
    // 所有展示的精度指标均应达标（配准 RMS、覆盖率、裂缝量测）
    expect(all).not.toContain('未达标');

    // 异常照片确实存在
    await page.goto('/#/registration');
    await page.waitForSelector('table');
    await expect(page.locator('body')).toContainText('待处理');
  });

  test('复检对比识别延伸与新增，报告评分链可运行', async ({ page }) => {
    await gotoSelftest(page);
    await clickAndWait(page, '① 生成合成数据集（两期）', 2000);
    await page.waitForFunction(() => document.body.innerText.includes('数据集概览'), { timeout: 180_000 });
    await clickAndWait(page, '② 自动配准全部照片', 2000);
    await page.waitForFunction(() => document.body.innerText.includes('配准精度指标'), { timeout: 300_000 });

    // 对比页
    await page.goto('/#/comparison');
    await page.waitForSelector('button');
    await page.getByRole('button', { name: '执行对比分析' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('对比汇总'), { timeout: 60_000 });
    const body = await page.locator('body').innerText();
    expect(body).toContain('延伸');
    expect(body).toContain('新增');
    // 至少一条延伸裂缝（合成设计：0.62->0.83m 与 1.25->1.55m）
    const extMatch = body.match(/延伸裂缝[\s\S]*?([0-9]+)/);
    expect(parseInt(extMatch![1], 10)).toBeGreaterThanOrEqual(1);

    // 报告页
    await page.goto('/#/report');
    await page.waitForFunction(() => document.body.innerText.includes('桥梁技术状况检测报告'), { timeout: 60_000 });
    const report = await page.locator('.report-page').innerText();
    expect(report).toContain('全桥技术状况评分');
    expect(report).toContain('构件评分与扣分明细');
  });

  test('档案与建模页：参数化构件自动编号、三维视图可加载', async ({ page }) => {
    await gotoSelftest(page);
    await clickAndWait(page, '① 生成合成数据集（两期）', 2000);
    await page.waitForFunction(() => document.body.innerText.includes('数据集概览'), { timeout: 180_000 });

    await page.goto('/#/modeling');
    await page.waitForSelector('canvas.gl');
    await page.waitForTimeout(1500);
    const body = await page.locator('body').innerText();
    expect(body).toContain('构件树');
    expect(body).toContain('1-1#主梁');
    expect(body).toContain('横隔板');
    expect(body).toContain('盖梁');

    await page.goto('/#/archive');
    await page.waitForSelector('table');
    const arch = await page.locator('body').innerText();
    expect(arch).toContain('测试桥');
  });
});
