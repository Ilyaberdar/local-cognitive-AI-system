globalThis.calculate = function(a, b, operation) {
    a = Number(a);
    b = Number(b);
    switch(operation) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/':
            if (b === 0) throw new Error('Division by zero');
            return a / b;
        default: throw new Error('Invalid operation');
    }
};

document.getElementById('calculate').addEventListener('click', function() {
    try {
        const a = document.getElementById('a').value;
        const b = document.getElementById('b').value;
        const operation = document.getElementById('operation').value;
        const result = calculate(a, b, operation);
        document.getElementById('result').textContent = result;
    } catch (error) {
        document.getElementById('result').textContent = error.message;
    }
});

document.getElementById('clear').addEventListener('click', function() {
    document.getElementById('a').value = '';
    document.getElementById('b').value = '';
    document.getElementById('result').textContent = '';
});