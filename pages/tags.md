---
layout: thoughts
title: Tags
permalink: /thoughts/tags/
---

<div class="tags-container">
    {% assign tags = site.tags | sort %}
    {% for tag in tags %}
        <section id="{{ tag[0] }}" class="tag-section">
            <ul class="post-list">
                {% for post in tag[1] %}
                    <li class="post-item">
                        <a href="{{ post.url }}" class="post-link">
                            <time class="post-date" datetime="{{ post.date | date_to_xmlschema }}">
                                {{ post.date | date: "%B %-d, %Y" }}
                            </time>
                            <h2 class="post-title">
                                {{ post.title }}
                            </h2>
                            {% if post.tags %}
                                <div class="post-tags">
                                    {% for tag in post.tags %}
                                        <span class="tag">{{ tag }}</span>
                                    {% endfor %}
                                </div>
                            {% endif %}
                            {% if post.description %}
                                <div class="post-description">{{ post.description }}</div>
                            {% endif %}
                        </a>
                    </li>
                {% endfor %}
            </ul>
        </section>
    {% endfor %}
</div>
