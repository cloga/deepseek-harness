// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ComponentProps } from 'react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect as ModelSelectComponent } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

type ModelSelectProps = ComponentProps<typeof ModelSelectComponent>
type FixtureProps = Omit<ModelSelectProps, 'useDirectory' | 'selectionError' | 'selectAuto'> & {
  directory: SnapshotStore<ModelDirectoryState>
  selectAuto?: ModelSelectProps['selectAuto']
}

/** The test runtime binds the same reactive selector hook the production Slot renderer provides. */
function ModelSelect({ directory, selectAuto = async () => false, ...props }: FixtureProps) {
  return <ModelSelectComponent {...props} useDirectory={bindSnapshotSelector(directory)}
    selectionError={() => directory.getSnapshot().error} selectAuto={selectAuto} />
}

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek-V4-Flash',
        description: 'Fast catalog description',
        reasoning,
      }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders effort names without descriptions and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'Max'])
    expect(screen.queryByText('Largest budget')).toBeNull()

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('shows the durable model id when the catalog has no matching display name', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型，当前 deepseek-official/removed-model' })
    expect(trigger.textContent).toContain('deepseek-official/removed-model')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    expect(screen.queryByRole('menuitemradio', { name: 'removed-model' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
    expect(screen.queryByText('Fast catalog description')).toBeNull()
  })

  it('shows loading until the catalog and Session projection are both ready', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state({
      current: null,
      routable: null,
      groups: [],
      status: 'loading',
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    expect(screen.getByRole('button', { name: '正在加载模型…' }).textContent)
      .toContain('正在加载模型…')
    directory.set(state())
    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
      })).toBeTruthy()
    })
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'session/model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：session/model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('portals the placed menu card to body and closes only on truly-outside mousedown', () => {
    const offsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')!
    const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 200 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 300 })
    try {
      const { container } = render(<ModelSelect
        locked={false}
        available
        directory={createSnapshotStore(state())}
        load={vi.fn()}
        select={vi.fn().mockResolvedValue(true)}
        t={t}
      />)
      const trigger = screen.getByRole('button', { name: /选择模型/ })
      fireEvent.click(trigger)
      const menu = screen.getByRole('menu')
      // Outside the composer subtree — column overflow clips cannot crop it.
      expect(container.contains(menu)).toBe(false)
      expect(menu.parentElement).toBe(document.body)
      // jsdom anchor rects are all zero, so the measured 200x300 card clamps
      // to the 12px viewport margin on both axes.
      expect(menu.style.left).toBe('12px')
      expect(menu.style.top).toBe('12px')
      // Interactions inside the trigger subtree or the portaled card stay open.
      fireEvent.mouseDown(menu)
      fireEvent.mouseDown(trigger)
      fireEvent.blur(trigger, { relatedTarget: menu })
      expect(screen.getByRole('menu')).toBeTruthy()
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', offsetHeight)
    }
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect Auto model and effort', () => {
  it.each([
    ['efficiency', '省钱优先'], ['balanced', '均衡'], ['intelligence', '质量优先'],
  ] as const)('selects %s without displaying a predicted concrete model', async (mode, label) => {
    const directory = createSnapshotStore(state({ autoRouting: { available: true, mode: 'manual', lastDecision: null } }))
    const select = vi.fn().mockResolvedValue(true)
    const selectAuto = vi.fn(async () => {
      directory.set(state({ current: null, autoRouting: { available: true, mode, lastDecision: null } }))
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} selectAuto={selectAuto} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Auto/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: label }))
    await waitFor(() => {
      expect(selectAuto).toHaveBeenCalledWith(mode)
      expect(screen.queryByRole('menu')).toBeNull()
    })
    const trigger = screen.getByRole('button', { name: `模型自动选择，当前策略 ${label}` })
    expect(trigger.textContent).toContain(`Auto · ${label}`)
    expect(trigger.title).toBe('任务开始时选择模型与推理等级')
    expect(trigger.textContent).not.toContain('DeepSeek-V4-Flash')
    expect(select).not.toHaveBeenCalled()
  })

  it('labels only the last actual model and effort and disables independent effort selection', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
      autoRouting: { available: true, mode: 'balanced', lastDecision: null },
    }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: '模型自动选择，当前策略 均衡' })
    expect(trigger.title).toBe('上次实际使用：DeepSeek-V4-Flash · Max')
    fireEvent.click(trigger)
    const effort = screen.getByRole('menuitem', { name: /推理等级/ }) as HTMLButtonElement
    expect(effort.disabled).toBe(true)
    expect(effort.title).toBe('推理等级随任务自动选择；指定模型可切回手动模式。')
    fireEvent.click(effort)
    expect(screen.queryByRole('menuitemradio', { name: 'Max' })).toBeNull()
  })

  it('does not infer omitted actual effort from the catalog default', () => {
    const directory = createSnapshotStore(state({ autoRouting: { available: true, mode: 'balanced', lastDecision: null } }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: '模型自动选择，当前策略 均衡' })
    expect(trigger.title).toBe('上次实际使用：DeepSeek-V4-Flash')
    expect(trigger.textContent).not.toContain('High')
  })

  it('retains actual effort when a provider no longer advertises the used model', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'external', model: 'removed', reasoningEffort: 'exact-effort' },
      autoRouting: { available: true, mode: 'intelligence', lastDecision: null },
    }))
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} t={t} />)
    expect(screen.getByRole('button', { name: '模型自动选择，当前策略 质量优先' }).title)
      .toBe('上次实际使用：external/removed · exact-effort')
  })

  it.each([undefined, 'max'])('pins the same concrete model and actual effort %s when leaving Auto', async (reasoningEffort) => {
    const current = { provider: 'deepseek-official', model: 'deepseek-v4-flash',
      ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    const directory = createSnapshotStore(state({ current, autoRouting: { available: true, mode: 'balanced', lastDecision: null } }))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection, autoRouting: { available: true, mode: 'manual', lastDecision: null } }))
      return true
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={select} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '模型自动选择，当前策略 均衡' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    const model = screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })
    expect(model.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(model)
    await waitFor(() => { expect(select).toHaveBeenCalledExactlyOnceWith(current) })
    expect(screen.queryByRole('button', { name: '模型自动选择，当前策略 均衡' })).toBeNull()
  })

  it('announces rejected Auto selection without treating it as a catalog load failure', async () => {
    const directory = createSnapshotStore(state({ autoRouting: { available: true, mode: 'manual', lastDecision: null } }))
    const selectAuto = vi.fn(async () => {
      directory.update((value) => { value.status = 'error'; value.error = 'classifier unavailable' })
      return false
    })
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} selectAuto={selectAuto} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Auto/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '均衡' }))
    expect((await screen.findByRole('alert')).textContent).toContain('模型操作失败：classifier unavailable')
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it.each(['unavailable', 'selecting'] as const)('prevents Auto mode submission while %s', (cause) => {
    const directory = createSnapshotStore(state({ autoRouting: { available: cause !== 'unavailable', mode: 'manual', lastDecision: null } }))
    const selectAuto = vi.fn().mockResolvedValue(true)
    render(<ModelSelect locked={false} available directory={directory} load={vi.fn()} select={vi.fn()} selectAuto={selectAuto} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Auto/ }))
    if (cause === 'selecting') act(() => { directory.update((value) => { value.status = 'selecting' }) })
    for (const choice of screen.getAllByRole('menuitemradio')) {
      expect((choice as HTMLButtonElement).disabled).toBe(true)
      fireEvent.click(choice)
    }
    if (cause === 'unavailable') expect(screen.getByText('请先在设置中配置并启用 Auto 路由策略。')).toBeTruthy()
    expect(selectAuto).not.toHaveBeenCalled()
  })

  it('keeps a locked trigger inert and keyboard navigation skips Auto-managed effort', () => {
    const directory = createSnapshotStore(state({ autoRouting: { available: true, mode: 'balanced', lastDecision: null } }))
    const load = vi.fn()
    const rendered = render(<ModelSelect locked available directory={directory} load={load} select={vi.fn()} t={t} />)
    const trigger = screen.getByRole('button', { name: '模型自动选择，当前策略 均衡' })
    fireEvent.click(trigger)
    expect(load).not.toHaveBeenCalled()
    rendered.rerender(<ModelSelect locked={false} available directory={directory} load={load} select={vi.fn()} t={t} />)
    fireEvent.click(trigger)
    const auto = screen.getByRole('menuitem', { name: /^Auto/ })
    const model = screen.getByRole('menuitem', { name: /^模型/ })
    auto.focus()
    fireEvent.keyDown(auto, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(model)
    fireEvent.keyDown(model, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(auto)
    fireEvent.click(auto)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.getByRole('menuitem', { name: /^Auto/ })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
