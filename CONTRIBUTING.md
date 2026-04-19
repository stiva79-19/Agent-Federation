# Contributing to Agent Federation

Welcome to Agent Federation! We're excited that you're interested in contributing to this project. This guide will help you get started.

## How to Contribute

1. **Fork the repository** — Create your own fork on GitHub
2. **Create a branch** — `git checkout -b feat/your-feature-name`
3. **Make your changes** — Implement your feature or fix
4. **Run tests** — Ensure all tests pass (`npm test`)
5. **Submit a pull request** — Create a PR with a clear description

## Development Setup

Follow these steps to set up your development environment:

```bash
# Clone the repository
git clone https://github.com/yourusername/agent-federation.git
cd agent-federation

# Install dependencies
npm install

# Set up environment variables
cp .env.example .env

# Run tests to verify everything works
npm test
```

## Code Style Rules

We maintain high code quality standards to keep the project maintainable and robust:

- **TypeScript strict mode** — All code must be written in TypeScript with `strict: true`. No `any` types are permitted.
- **Zero external dependencies for core modules** — Core functionality must not depend on external packages. Use the standard library or built-in Node.js modules.
- **All exports through src/index.ts** — Public APIs must be exported from the main entry point (`src/index.ts`). This creates a clear contract for users.
- **Conventional commits** — Commit messages must follow the Conventional Commits format:
  - `feat:` for new features
  - `fix:` for bug fixes
  - `docs:` for documentation changes
  - `test:` for test additions or changes
  - `refactor:` for code refactoring without feature changes

Example: `feat: add federation mesh support`

## Testing Requirements

Quality testing is essential to this project:

- **All tests must pass** — Run `npm test` before submitting your PR. No exceptions.
- **New features require tests** — Every new feature must include corresponding unit tests.
- **Test framework** — We use [Vitest](https://vitest.dev/) for all test suites.
- **Coverage** — Generate coverage reports with:
  ```bash
  npm test -- --run --coverage
  ```

We aim for high coverage on core functionality.

## Pull Request Process

To ensure smooth review and integration:

1. **Create a descriptive PR title** — Use the Conventional Commits format (e.g., "feat: add mesh federation")
2. **Reference related issues** — Link to any issues your PR addresses (e.g., "Closes #123")
3. **Ensure CI passes** — All automated checks must pass before review
4. **One approval required** — Your PR needs at least one approving review before merging
5. **Keep it focused** — Avoid mixing unrelated changes in a single PR

## Issue Guidelines

Help us keep the issue tracker organized:

- **Use templates** — Choose from our templates:
  - Bug report — For reporting bugs with reproduction steps
  - Feature request — For proposing new features
- **Include reproduction steps** — For bugs, provide clear steps to reproduce the issue
- **One issue per report** — Don't combine multiple unrelated issues in a single report

## Security

Security issues should be handled responsibly:

- **Report vulnerabilities via SECURITY.md** — Never open public issues for security vulnerabilities
- **Refer to SECURITY.md** for detailed instructions on responsible disclosure

## Code of Conduct

All contributors must follow our [Code of Conduct](CODE_OF_CONDUCT.md). We're committed to providing a welcoming and inclusive environment.

## License

By contributing to Agent Federation, you agree that your contributions will be licensed under the [MIT License](LICENSE).

Thank you for contributing!
