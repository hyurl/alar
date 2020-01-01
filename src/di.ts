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
            return module.instance(route);
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

export abstract class Injectable {
    inject(this: ModuleProxy<any>, route: any = ""): PropertyDecorator {
        return addDependency({
            module: this,
            route
        });
    }
}