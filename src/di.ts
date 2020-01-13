// NOTE: Dependency Injection is marked deprecated since v5.6, and very likely
// to be removed in the next release.

import { dict } from './util';

const dependencies = Symbol("dependencies");

type Dependency = {
    module: ModuleProxy<any>;
    route?: any
};

function defineAccessor(target: any, prop: string): void {
    Object.defineProperty(target, prop, {
        configurable: false,
        enumerable: false,
        get(this: any) {
            let { module, route } = <Dependency>this[dependencies][prop];
            return module(route);
        }
    });
}

function addDependency(dependency: Dependency) {
    return (target: any, prop: string) => {
        if (target[dependencies] === undefined) {
            target[dependencies] = dict();
        }

        target[dependencies][prop] = dependency;

        defineAccessor(target, prop);
    };
}

/**
 * @deprecated
 */
export abstract class Injectable {
    inject(this: ModuleProxy<any>, route: any = void 0): PropertyDecorator {
        return addDependency({
            module: this,
            route
        });
    }
}