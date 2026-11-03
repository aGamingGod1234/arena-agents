#!/usr/bin/env python3
"""Check every mixin's targets against one Minecraft version's real classes, without starting the game.

A mixin compiles against whatever the build classpath holds, but its targets (the class, the injected method names,
@At invoke/field targets, @Accessor fields and @Invoker methods) are only resolved when Minecraft loads. A target that
moved between 26.x drops compiles fine and then fails at startup. This reads the mixin sources the build would use for a
target (src/main, src/client, and src/compat/<target>/) and checks each target with javap against the deobfuscated jar.

    python3 scripts/check-mixin-targets.py <compat target, e.g. 26.2> <minecraft jar> [carpet jar, brigadier jar...] [--javap PATH]

Exit 0 when every target resolves; otherwise each unresolved target is listed and the exit code is 1.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from functools import lru_cache

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def mixin_roots(target):
    return [os.path.join(ROOT, 'src', part, 'java') for part in ('main', 'client')] + [
        os.path.join(ROOT, 'src', 'compat', target, part) for part in ('java', 'clientJava')]


def configs(target):
    names = ['src/main/resources/arenaagents.mixins.json', 'src/client/resources/arenaagents.client.mixins.json',
             f'src/compat/{target}/resources/arenaagents.compat.mixins.json',
             f'src/compat/{target}/clientResources/arenaagents.client.compat.mixins.json']
    found = []
    for name in names:
        path = os.path.join(ROOT, name)
        if not os.path.isfile(path):
            continue
        data = json.load(open(path))
        for key in ('mixins', 'client', 'server'):
            for mixin in data.get(key, []):
                found.append(data['package'] + '.' + mixin)
    return found


def source_for(fqcn, target):
    relative = fqcn.replace('.', os.sep) + '.java'
    for root in mixin_roots(target):
        path = os.path.join(root, relative)
        if os.path.isfile(path):
            return path
    return None


class Jar:
    def __init__(self, jars, javap):
        self.jar, self.javap = os.pathsep.join(jars), javap
        self.classes = set()
        for jar in jars:
            listing = subprocess.run(['unzip', '-Z1', jar], capture_output=True, text=True, check=True).stdout.split()
            self.classes |= {name[:-6].replace('/', '.') for name in listing if name.endswith('.class')}

    @lru_cache(maxsize=None)
    def members(self, fqcn):
        """(methods {name: [descriptors]}, fields {name}) declared by the class or inherited from Minecraft supertypes."""
        out = subprocess.run([self.javap, '-p', '-s', '-cp', self.jar, fqcn], capture_output=True, text=True).stdout
        methods, fields, supers = {}, set(), []
        header = next((line for line in out.splitlines() if re.search(r'\b(class|interface|enum|record)\b', line)), '')
        for clause in re.findall(r'(?:extends|implements) ([^{]+)', header):
            supers += [re.sub(r'<.*', '', part.strip()) for part in clause.split(',')]
        lines = out.splitlines()
        for index, line in enumerate(lines):
            if 'descriptor:' not in line or index == 0:
                continue
            descriptor = line.split('descriptor:')[1].strip()
            decl = lines[index - 1]
            match = re.search(r'([\w$<>]+)\(', decl)
            if match and descriptor.startswith('('):
                name = match.group(1)
                if name == fqcn.split('.')[-1] or name == fqcn.split('.')[-1].split('$')[-1]:
                    name = '<init>'
                methods.setdefault(name, []).append(descriptor)
            elif not descriptor.startswith('('):
                field = re.search(r'([\w$]+);\s*$', decl)
                if field:
                    fields.add(field.group(1))
        for parent in supers:
            parent = parent.split()[0]
            if parent in self.classes:
                parent_methods, parent_fields = self.members(parent)
                for name, descriptors in parent_methods.items():
                    methods.setdefault(name, []).extend(descriptors)
                fields |= parent_fields
        return methods, fields


def imports(source):
    table = {}
    for match in re.finditer(r'^import\s+([\w.]+)\s*;', source, re.M):
        table[match.group(1).split('.')[-1]] = match.group(1)
    return table


def resolve(name, table):
    head, _, rest = name.partition('.')
    if head in table:
        base = table[head]
        return base + ('$' + rest.replace('.', '$') if rest else '')
    return name


def at_target_values(source):
    """Yield (value, error) for every @At target; never accept a partial expression.

    This deliberately supports a small Java string-constant grammar. Imported constants,
    text blocks and other Java expressions require explicit support rather than silent skips.
    """
    tokens = [m.group() for m in re.finditer(
        r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[\w$]+|[^\s]', source)
        if not m.group().startswith(('//', '/*'))]
    constants = {}
    for i in range(len(tokens) - 4):
        if tokens[i:i + 2] == ['final', 'String'] and tokens[i + 3] == '=':
            end = i + 4
            while end < len(tokens) and tokens[end] != ';':
                end += 1
            name = tokens[i + 2]
            # Ambiguous declarations (e.g. nested classes) must not pick an arbitrary value.
            constants[name] = None if name in constants else tokens[i + 4:end]

    def evaluate(parts, active=frozenset()):
        index = 0

        def expression():
            nonlocal index
            value = atom()
            while index < len(parts) and parts[index] == '+':
                index += 1
                value += atom()
            return value

        def atom():
            nonlocal index
            if index >= len(parts):
                raise ValueError('incomplete string expression')
            token = parts[index]
            index += 1
            if token == '(':
                value = expression()
                if index >= len(parts) or parts[index] != ')':
                    raise ValueError('unbalanced parentheses')
                index += 1
                return value
            if token.startswith('"'):
                try:
                    return json.loads(token)
                except ValueError:
                    raise ValueError('unsupported string literal escape') from None
            if token in active:
                raise ValueError(f'cyclic constant {token}')
            if token not in constants or constants[token] is None:
                raise ValueError(f'unknown or ambiguous constant {token}')
            return evaluate(constants[token], active | {token})

        value = expression()
        if index != len(parts):
            raise ValueError('unsupported tokens in string expression')
        return value

    for i in range(len(tokens) - 2):
        if tokens[i] != '@':
            continue
        j = i + 1
        while j + 2 < len(tokens) and tokens[j + 1] == '.':
            j += 2
        if tokens[j:j + 2] != ['At', '(']:
            continue
        depth, j = 0, j + 2
        while j < len(tokens):
            token = tokens[j]
            if token == ')' and depth == 0:
                break
            if depth == 0 and tokens[j:j + 2] == ['target', '=']:
                start = j + 2
                j = start
                nested = 0
                while j < len(tokens):
                    token = tokens[j]
                    if nested == 0 and token in (',', ')'):
                        break
                    if token == '(':
                        nested += 1
                    elif token == ')':
                        nested -= 1
                    j += 1
                parts = tokens[start:j]
                try:
                    yield evaluate(parts), None
                except ValueError as error:
                    yield None, f"unsupported @At target expression {' '.join(parts)}: {error}"
                continue
            if token == '(':
                depth += 1
            elif token == ')':
                depth -= 1
            j += 1


def check(jar, target):
    problems, checked = [], 0
    for mixin in configs(target):
        path = source_for(mixin, target)
        if path is None:
            problems.append(f'{mixin}: listed in a mixin config but no source file')
            continue
        source = open(path).read()
        table = imports(source)
        short = os.path.relpath(path, ROOT)
        head = re.search(r'@Mixin\s*\(([^)]*)\)', source, re.S)
        targets = [resolve(name, table) for name in re.findall(r'([\w.]+)\.class', head.group(1))] if head else []
        targets += [name.replace('/', '.') for name in re.findall(r'targets\s*=\s*\{?\s*"([^"]+)"', head.group(1))] if head else []
        for owner in targets:
            checked += 1
            if owner not in jar.classes:
                problems.append(f'{short}: @Mixin target {owner} does not exist')
        present = [owner for owner in targets if owner in jar.classes]
        if not present:
            continue
        owner_methods, owner_fields = {}, set()
        for owner in present:
            methods, fields = jar.members(owner)
            for name, descriptors in methods.items():
                owner_methods.setdefault(name, []).extend(descriptors)
            owner_fields |= fields
        # Injected method names (method = "name" or {"a", "b"}; an optional descriptor after the name).
        for group in re.findall(r'\bmethod\s*=\s*(\{[^}]*\}|"[^"]*")', source):
            for entry in re.findall(r'"([^"]+)"', group):
                checked += 1
                name = entry.split('(')[0].split(':')[0]
                if name == '*':
                    continue
                if name not in owner_methods:
                    problems.append(f'{short}: injected method {name} not in {"/".join(present)}')
                elif '(' in entry and entry[entry.index('('):] not in owner_methods[name]:
                    problems.append(f'{short}: injected method {entry} has no matching descriptor')
        # @At targets: Lowner;name(desc)ret for INVOKE, Lowner;name:type for FIELD.
        for value, error in at_target_values(source):
            if error:
                problems.append(f'{short}: {error}')
                continue
            match = re.match(r'L([\w/$]+);([\w<>$]+)(\(.*|:.*)$', value)
            if not match:
                continue
            checked += 1
            owner = match.group(1).replace('/', '.')
            name, rest = match.group(2), match.group(3)
            if owner not in jar.classes:
                if owner.startswith(('net.minecraft.', 'com.mojang.')):
                    problems.append(f'{short}: @At target owner {owner} does not exist ({name})')
                continue
            methods, fields = jar.members(owner)
            if rest.startswith(':'):
                if name not in fields:
                    problems.append(f'{short}: @At field {owner}.{name} does not exist')
            elif name not in methods:
                problems.append(f'{short}: @At method {owner}.{name} does not exist')
            elif rest not in methods[name]:
                problems.append(f'{short}: @At method {owner}.{name}{rest} has no matching descriptor (have {methods[name]})')
        for kind, name in re.findall(r'@(Accessor|Invoker)\s*\(\s*(?:value\s*=\s*)?"([^"]+)"', source):
            if name.startswith('arenaagents$'):
                continue  # a field or method another of the mod's mixins adds, not vanilla's
            checked += 1
            if kind == 'Accessor' and name not in owner_fields:
                problems.append(f'{short}: @Accessor field {name} not in {"/".join(present)}')
            if kind == 'Invoker' and name not in owner_methods:
                problems.append(f'{short}: @Invoker method {name} not in {"/".join(present)}')
    return checked, problems


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('target')
    parser.add_argument('jars', nargs='+', help='the deobfuscated Minecraft jar, then Carpet and other mixin target jars')
    parser.add_argument('--javap', default=os.path.join(os.environ.get('JAVA_HOME', ''), 'bin', 'javap') if os.environ.get('JAVA_HOME') else 'javap')
    args = parser.parse_args()
    checked, problems = check(Jar(args.jars, args.javap), args.target)
    for problem in problems:
        print(problem)
    print(f'{checked} mixin targets checked for {args.target}: {len(problems)} unresolved')
    sys.exit(1 if problems else 0)


if __name__ == '__main__':
    main()
