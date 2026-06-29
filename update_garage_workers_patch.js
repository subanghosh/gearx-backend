const fs = require('fs');
let content = fs.readFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', 'utf8');

const regex = /await pool\.query\(\`UPDATE users SET \$\{fields\.join\(\', \'\)\} WHERE id = \$\$[^\`]+\`, vals\);/g;
if(regex.test(content)) {
    content = content.replace(regex, (match) => {
        return match + '\n        await pool.query(`UPDATE garage_workers SET ${fields.join(\', \')} WHERE id = $${idx}`, vals).catch(() => {});';
    });
    fs.writeFileSync('C:/Users/Suban/OneDrive/Documents/vroomly-backend/index.js', content);
    console.log('Successfully updated PATCH /users/:id to also update garage_workers');
} else {
    console.log('Regex did not match');
}
