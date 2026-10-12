# Contributing to ComposeOps

Thank you for your interest in contributing! This document provides guidelines and instructions for contributing to ComposeOps.

## 🌟 Ways to Contribute

- 🐛 **Report bugs** via [GitHub Issues](https://github.com/StanlySGY/ComposeOps/issues)
- 💡 **Suggest features** in [GitHub Discussions](https://github.com/StanlySGY/ComposeOps/discussions)
- 📝 **Improve documentation** (guides, examples, translations)
- 🧪 **Add tests** to increase coverage
- 🎨 **Enhance UI/UX** (design improvements, accessibility)
- 🔧 **Fix bugs** or implement features
- 🌍 **Translate** the interface (currently Chinese only)

## 🚀 Getting Started

### Prerequisites

- Node.js 22+
- Docker 20.10+
- npm 10+
- Git

### Development Setup

1. **Fork the repository** on GitHub

2. **Clone your fork**
   ```bash
   git clone https://github.com/YOUR_USERNAME/ComposeOps.git
   cd ComposeOps
   ```

3. **Add upstream remote**
   ```bash
   git remote add upstream https://github.com/StanlySGY/ComposeOps.git
   ```

4. **Install dependencies**
   ```bash
   npm install
   ```

5. **Run tests** to verify setup
   ```bash
   npm test
   ```

6. **Start development servers**
   ```bash
   # Terminal 1: Backend (http://localhost:3001)
   npm run dev --workspace=backend

   # Terminal 2: Frontend (http://localhost:5173)
   npm run dev --workspace=frontend
   ```

## 📋 Development Workflow

### 1. Create a Branch

Always work on a feature branch, never on `main`:

```bash
git checkout -b feature/your-feature-name
```

Branch naming conventions:
- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `test/` - Test additions/improvements
- `refactor/` - Code refactoring
- `chore/` - Maintenance tasks

### 2. Make Changes

- Follow existing code style and conventions
- Write clear, self-documenting code
- Add comments for complex logic
- Update documentation if needed

### 3. Test Your Changes

```bash
# Run all tests
npm test

# Backend tests only
cd backend && npm test

# Frontend tests only
cd frontend && npm test

# Build to verify production bundle
npm run build
```

### 4. Commit Your Changes

We use [Conventional Commits](https://www.conventionalcommits.org/):

```bash
git add .
git commit -m "feat: add batch operation progress bar"
```

Commit message format:
```
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, no logic change)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples:**
```bash
git commit -m "feat(agent): add batch rollback capability"
git commit -m "fix(logs): resolve memory leak in streaming logs"
git commit -m "docs: update AI agent usage guide"
git commit -m "test: add coverage for OperationsView filters"
```

### 5. Push and Create Pull Request

```bash
git push origin feature/your-feature-name
```

Then create a Pull Request on GitHub:
1. Go to your fork on GitHub
2. Click "Pull Request"
3. Fill out the PR template
4. Link related issues

## 📐 Code Style Guidelines

### General Principles

- **Clarity over cleverness**: Code should be easy to understand
- **Consistency**: Follow existing patterns in the codebase
- **DRY**: Don't Repeat Yourself (extract common logic)
- **YAGNI**: You Aren't Gonna Need It (avoid premature optimization)

### Frontend (Vue 3)

```vue
<script setup>
// 1. Imports (Vue APIs first, then libraries, then local)
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client.js';

// 2. Props and emits
const props = defineProps({
  show: { type: Boolean, default: false },
  items: { type: Array, required: true }
});
const emit = defineEmits(['confirm', 'cancel']);

// 3. Reactive state
const loading = ref(false);
const selectedItem = ref(null);

// 4. Computed properties
const filteredItems = computed(() => 
  props.items.filter(item => item.visible)
);

// 5. Functions
async function handleConfirm() {
  loading.value = true;
  try {
    await api.performAction();
    emit('confirm');
  } finally {
    loading.value = false;
  }
}

// 6. Lifecycle hooks and watchers
onMounted(() => loadData());
watch(() => props.show, (show) => {
  if (show) reset();
});
</script>
```

**Rules:**
- Use Composition API with `<script setup>`
- Name components in PascalCase
- Keep components under 300 lines (split if larger)
- Use `ref()` for primitives, `reactive()` for objects
- Destructure props only when needed (prefer `props.xxx`)
- Use `const` by default, `let` only when reassignment needed

### Backend (Node.js)

```javascript
// Use ESM imports
import Fastify from 'fastify';
import { validateConfig } from './utils.js';

// Named exports for utilities
export function sanitizePath(path) {
  // Implementation
}

// Default export for main module
export default async function buildServer(opts = {}) {
  const fastify = Fastify({
    logger: { level: opts.logLevel || 'info' }
  });
  
  // Register plugins
  await fastify.register(routes);
  
  return fastify;
}
```

**Rules:**
- Use ESM (`import`/`export`) not CommonJS (`require`)
- Async/await over callbacks
- Named exports for utilities, default for main module
- Error handling: try-catch with meaningful messages
- Input validation: check all user input

### CSS (Tailwind)

```vue
<template>
  <!-- Use semantic utility classes -->
  <button class="btn-primary">
    <Save class="h-4 w-4" />
    保存
  </button>
  
  <!-- Responsive design -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
    <!-- Cards -->
  </div>
  
  <!-- Dark theme tokens -->
  <div class="bg-surface-900 text-surface-100">
    Content
  </div>
</template>
```

**Rules:**
- Use existing design tokens (colors, spacing)
- Mobile-first responsive design
- Extract repeated patterns to components
- Dark theme by default (use `text-surface-*` not `text-gray-*`)

## 🧪 Testing Guidelines

### Frontend Tests (Vitest)

```javascript
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MyComponent from '../MyComponent.vue';

describe('MyComponent', () => {
  it('renders correctly', () => {
    const wrapper = mount(MyComponent, {
      props: { title: 'Test' }
    });
    expect(wrapper.text()).toContain('Test');
  });

  it('emits event on button click', async () => {
    const wrapper = mount(MyComponent);
    await wrapper.find('button').trigger('click');
    expect(wrapper.emitted('confirm')).toBeTruthy();
  });
});
```

### Backend Tests (Node.js test runner)

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseYaml } from '../src/utils.js';

describe('parseYaml', () => {
  it('parses valid YAML', () => {
    const result = parseYaml('key: value');
    assert.deepStrictEqual(result, { key: 'value' });
  });

  it('throws on invalid YAML', () => {
    assert.throws(() => parseYaml('invalid: ['), {
      name: 'Error'
    });
  });
});
```

**Coverage targets:**
- New features: 80%+ coverage
- Bug fixes: Include regression test
- Critical paths: 100% coverage

## 📝 Documentation Guidelines

### Code Comments

```javascript
// Good: Explain WHY, not WHAT
// Retry failed SSE connections with exponential backoff
// to handle transient network issues
setTimeout(() => reconnect(), delay * 2);

// Bad: Obvious comment
// Set loading to true
loading.value = true;
```

### Markdown Documentation

- Use clear headings and structure
- Include code examples
- Add screenshots for UI features
- Keep language simple and concise

## 🌍 Translation (i18n)

Currently ComposeOps is Chinese-only. We welcome translations!

### Priority Languages
1. English (en)
2. Spanish (es)
3. French (fr)
4. German (de)
5. Japanese (ja)

### Translation Process

1. Create locale file: `frontend/src/locales/en.json`
2. Add translations for all keys
3. Update `i18n.js` configuration
4. Test UI in new language
5. Submit PR with screenshots

## 🚫 What NOT to Submit

- **Credentials**: No API keys, passwords, or secrets
- **Personal data**: No real user data or logs
- **Generated files**: No `node_modules/`, `dist/`, `.env`
- **Large files**: No binaries >1MB (use Git LFS if needed)
- **Breaking changes**: Discuss major changes first in Issues

## ✅ Pull Request Checklist

Before submitting your PR:

- [ ] Code follows style guidelines
- [ ] Tests added/updated and passing (`npm test`)
- [ ] Documentation updated (README, docs/)
- [ ] Commit messages follow Conventional Commits
- [ ] Branch is up-to-date with `main`
- [ ] No merge conflicts
- [ ] PR description clearly explains changes
- [ ] Related issues linked

## 🔍 Code Review Process

1. **Automated checks**: Tests, linting, and build must pass
2. **Maintainer review**: At least one maintainer approval required
3. **Feedback**: Address review comments or explain disagreement
4. **Merge**: Maintainer will merge when approved

**Review timeline:**
- Simple fixes: 1-2 days
- Features: 3-7 days
- Large refactors: 1-2 weeks

## 🏗️ Project Structure

```
ComposeOps/
├── backend/
│   ├── src/
│   │   ├── routes/          # API endpoints
│   │   ├── services/        # Business logic
│   │   ├── db/              # Database layer
│   │   └── utils/           # Helper functions
│   └── test/                # Backend tests
├── frontend/
│   ├── src/
│   │   ├── views/           # Page components
│   │   ├── components/      # Reusable UI components
│   │   │   ├── agent/       # Agent-specific components
│   │   │   ├── common/      # Shared components
│   │   │   └── services/    # Service management
│   │   ├── api/             # API client + SWR caching
│   │   ├── stores/          # State management
│   │   └── composables/     # Vue composables
│   └── tests/               # Frontend tests
├── docs/                    # Documentation
└── docker-compose.yml       # Deployment config
```

## 🐛 Bug Reports

Use the [Bug Report template](.github/ISSUE_TEMPLATE/bug_report.md):

**Include:**
- ComposeOps version
- Docker version
- Operating system
- Steps to reproduce
- Expected vs actual behavior
- Screenshots/logs if applicable

## 💡 Feature Requests

Use the [Feature Request template](.github/ISSUE_TEMPLATE/feature_request.md):

**Include:**
- Clear description of the feature
- Use case / problem it solves
- Proposed solution (optional)
- Alternatives considered (optional)

## 📬 Questions & Support

- **Usage questions**: [GitHub Discussions](https://github.com/StanlySGY/ComposeOps/discussions)
- **Bugs**: [GitHub Issues](https://github.com/StanlySGY/ComposeOps/issues)
- **Security issues**: See [SECURITY.md](SECURITY.md)

## 🚢 Release & Publishing (Maintainers)

Releases are automated via GitHub Actions on version tags:

1. **Tag a release** (CI must be green on `main` first):
   ```bash
   git tag -a v1.2.0 -m "Release v1.2.0"
   git push origin v1.2.0
   ```
2. The [`release.yml`](.github/workflows/release.yml) workflow then:
   - Builds the frontend and creates a GitHub Release with notes extracted from `CHANGELOG.md` (requires a matching `## [x.y.z]` entry);
   - Builds multi-arch Docker images (amd64 + arm64) and pushes them to Docker Hub as `stanly1997/opsdash` with `latest`, major, minor, and full-version tags.

**Required repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
|--------|---------|
| `DOCKER_USERNAME` | Docker Hub username for `stanly1997/opsdash` |
| `DOCKER_PASSWORD` | Docker Hub access token (use a token, not the account password) |

Without these secrets the GitHub Release still ships; only the Docker Hub push fails. To publish under your own namespace, also update the `tags:` block in `release.yml` and the image references in both READMEs / `docker-compose.yml`.

**Version bump checklist** before tagging:
- [ ] Root `package.json` version updated
- [ ] `CHANGELOG.md` has a `## [x.y.z] - YYYY-MM-DD` entry
- [ ] `SECURITY.md` "Supported Versions" table covers the new minor

## 📜 Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to uphold this code.

**In short:**
- Be respectful and inclusive
- Welcome diverse perspectives
- Accept constructive criticism
- Focus on what's best for the community

## 🎉 Recognition

Contributors will be:
- Listed in [CONTRIBUTORS.md](CONTRIBUTORS.md)
- Mentioned in release notes
- Credited in the README (for significant contributions)

---

Thank you for contributing to ComposeOps! 🙏
